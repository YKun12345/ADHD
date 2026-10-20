"""F00 local IPC compatibility. No hospital channel or real patient inputs."""
import argparse,importlib.metadata,json,os,subprocess,sys,tempfile,threading,time
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
from federated_runtime.framing import read_frame,write_frame


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode',choices=['public_vectors','synthetic_dp'],default='public_vectors')
    parser.add_argument('--drop-node',type=int,choices=[1,2,3])
    parser.add_argument('--synthetic-only',action='store_true',required=True)
    args=parser.parse_args()
    required={'flwr':'1.23.0','opacus':'1.5.4','torch':'2.6.0','numpy':'1.26.4'}
    try:actual={name:importlib.metadata.version(name) for name in required}
    except importlib.metadata.PackageNotFoundError:parser.error('Independent dependencies are not fully installed; F00 compatibility has not run.')
    if actual!=required or Path(sys.prefix).resolve().name!='.venv-federated':parser.error('Use the isolated pinned .venv-federated after its dependency installation completes.')
    import numpy as np
    from flwr.common import ConfigRecord,Context,FitIns,RecordDict,ndarrays_to_parameters,parameters_to_ndarrays
    from flwr.common.recorddict_compat import parameters_to_arrayrecord
    from flwr.common.serde import message_from_proto,message_to_proto
    from flwr.proto.message_pb2 import Message as ProtoMessage
    from flwr.server import LegacyContext
    from flwr.server.workflow import SecAggPlusWorkflow
    from flwr.server.workflow.constant import MAIN_CONFIGS_RECORD,MAIN_PARAMS_RECORD,Key
    from federated_runtime.compatibility_node import initial_arrays,public_delta
    root=Path(__file__).resolve().parents[1];directory=Path(tempfile.mkdtemp(prefix='federated-f00-',dir=root/'.codex-tmp'))
    print(json.dumps({'runtime_directory':str(directory),'status':'started_synthetic_compatibility'}),flush=True)
    base=initial_arrays();children={};logs=[];rounds=[];started=time.monotonic()
    proxies=[SimpleNamespace(node_id=nid,cid=str(nid)) for nid in (1,2,3)]
    def process_info(nid):
        path=directory/('node-'+str(nid))/'process.json'
        return json.loads(path.read_text(encoding='utf8')) if path.exists() else {}
    class Strategy:
        applied=False
        receipts=[]
        aggregate=None
        def configure_fit(self,server_round,parameters,client_manager):
            return [(proxy,FitIns(parameters,{})) for proxy in proxies]
        def aggregate_fit(self,server_round,results,failures):
            if failures or len(results)!=3 or any(value.num_examples!=1 for _,value in results):raise ValueError('All three institutions with fixed weight one are required.')
            for proxy,value in results:
                info=process_info(proxy.node_id);launcher=children[proxy.node_id].pid
                if info.get('node_id')!=proxy.node_id or info.get('mode')!=args.mode or launcher not in {info.get('pid'),info.get('parent_pid')} or value.metrics.get('node_pid')!=info.get('pid') or value.metrics.get('institution_weight')!=1:raise ValueError('A protocol receipt is not from its actual independent node process.')
            if len({value.metrics['node_pid'] for _,value in results})!=3:raise ValueError('The three protocol nodes must be distinct actual processes.')
            mean=parameters_to_ndarrays(results[0][1].parameters)
            if len(mean)!=len(base) or any(value.shape!=prior.shape or not np.isfinite(value).all() for value,prior in zip(mean,base)):raise ValueError('The actual secure aggregate is structurally invalid.')
            self.receipts=[dict(value.metrics) for _,value in results]
            self.aggregate=mean;self.applied=True
            return ndarrays_to_parameters([prior+delta for prior,delta in zip(base,mean)]),{}
    strategy=Strategy()
    class LocalGrid:
        def send_and_receive(self,messages,timeout=None):
            result=[];phase=[]
            for message in messages:
                node=message.metadata.dst_node_id
                if node==args.drop_node:continue
                child=children[node];proto=message_to_proto(message);proto.metadata.run_id=1;proto.metadata.message_id=uuid4().hex;proto.metadata.src_node_id=0
                timer=threading.Timer(min(float(timeout or 60),60),child.kill)
                try:
                    timer.start();wire=proto.SerializeToString();write_frame(child.stdin,wire);raw=read_frame(child.stdout);reply=message_from_proto(ProtoMessage.FromString(raw))
                    if reply.metadata.src_node_id!=node or reply.metadata.dst_node_id!=0 or reply.metadata.run_id!=1 or reply.metadata.reply_to_message_id!=proto.metadata.message_id:raise ValueError('Reply identity differs from the actual node request.')
                    result.append(reply);phase.append({'node_id':node,'request_bytes':len(wire),'reply_bytes':len(raw),'has_error':reply.has_error()})
                except (EOFError,BrokenPipeError):phase.append({'node_id':node,'closed':True})
                finally:timer.cancel()
            rounds.append(phase);return result
    try:
        for node in (1,2,3):
            node_dir=directory/('node-'+str(node));node_dir.mkdir();log=(node_dir/'stderr.txt').open('wb');logs.append(log)
            children[node]=subprocess.Popen([sys.executable,'-m','federated_runtime.compatibility_node','--node-id',str(node),'--mode',args.mode,'--directory',str(node_dir),'--synthetic-only'],cwd=root,
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0,
                env={**os.environ,'OMP_NUM_THREADS':'1','FLWR_TELEMETRY_ENABLED':'0'})
        context=LegacyContext(Context(run_id=1,node_id=0,node_config={},state=RecordDict(),run_config={}),strategy=strategy)
        for proxy in proxies:context.client_manager.register(proxy)
        context.state.config_records[MAIN_CONFIGS_RECORD]=ConfigRecord({Key.CURRENT_ROUND:1,Key.START_TIME:time.time()})
        context.state.array_records[MAIN_PARAMS_RECORD]=parameters_to_arrayrecord(ndarrays_to_parameters(base),True)
        # Ratio 1.0 requests three shares and all three reconstructions in this
        # release; integer threshold=shares would be rejected by Flower 1.23.
        workflow=SecAggPlusWorkflow(num_shares=1.0,reconstruction_threshold=1.0,max_weight=1.,clipping_range=1.,quantization_range=2**20,modulus_range=2**32,timeout=60.)
        workflow(LocalGrid(),context)
        receipt={'mode':args.mode,'synthetic_only':True,'transport':'bounded_local_protobuf_pipes','versions':actual,'node_pids':{node:process_info(node).get('pid') for node in children},'launcher_pids':{node:child.pid for node,child in children.items()},'protocol_phases':rounds,
                 'applied':strategy.applied,'secure_rng_for_dp':False,'real_patient_training_allowed':False,'hospital_deployment_verified':False,'encoder_protected':False}
        if args.drop_node:
            if strategy.applied:raise ValueError('An insufficient-participation run unexpectedly released an aggregate.')
            receipt['status']='threshold_rejected'
        else:
            if not strategy.applied or len(rounds)!=4 or any(len(phase)!=3 for phase in rounds):raise ValueError('The complete three-node SecAgg+ workflow did not finish.')
            receipt['status']='passed_synthetic_compatibility';receipt['node_receipts']=strategy.receipts
            if args.mode=='public_vectors':
                expected=[np.mean([public_delta(nid)[index] for nid in (1,2,3)],axis=0) for index in range(len(base))]
                error=max(float(np.max(np.abs(value-target))) for value,target in zip(strategy.aggregate,expected))
                receipt['public_vector_max_abs_error']=error
                if error>8/(2**20):raise ValueError('Signed single-quantization control exceeds the frozen error bound.')
            else:
                from opacus.accountants import RDPAccountant
                accountant=RDPAccountant()
                for value in strategy.receipts:
                    history=json.loads(value['accountant_history'])
                    if sum(step[2] for step in history)!=value['logical_steps']:raise ValueError('Privacy receipt does not match actual logical optimizer steps.')
                    for noise,rate,steps in history:
                        for _ in range(steps):accountant.step(noise_multiplier=noise,sample_rate=rate)
                receipt['conservative_sequential_epsilon']=accountant.get_epsilon(delta=1e-5);receipt['overall_delta']=1e-5
            np.savez(directory/'synthetic-global-classifier.npz',**{f'parameter_{i}':value+delta for i,(value,delta) in enumerate(zip(base,strategy.aggregate))})
        receipt['elapsed_seconds']=round(time.monotonic()-started,3)
        (directory/'receipt.json').write_text(json.dumps(receipt,indent=2),encoding='utf8');print(json.dumps({'runtime_directory':str(directory),**receipt},indent=2))
    except Exception as error:
        (directory/'failed-receipt.json').write_text(json.dumps({'status':'failed','error_type':type(error).__name__,'synthetic_only':True,'node_pids':{node:child.pid for node,child in children.items()},'protocol_phases':rounds},indent=2),encoding='utf8')
        raise
    finally:
        for child in children.values():
            if child.stdin:child.stdin.close()
            try:child.wait(timeout=3)
            except subprocess.TimeoutExpired:child.kill();child.wait(timeout=3)
        for log in logs:log.close()


if __name__=='__main__':main()
