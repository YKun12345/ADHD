"""An independent F00 node: official SecAgg+ and actual synthetic DP training."""
import argparse,contextlib,json,os,sys
from pathlib import Path
from uuid import uuid4
from federated_runtime.framing import read_frame,write_frame


def initial_arrays():
    import torch
    # This seed defines the public initial classifier only. fork_rng restores
    # the unseeded process RNG before any sampling, DP noise or key generation.
    with torch.random.fork_rng():
        torch.manual_seed(1729)
        model=torch.nn.Linear(4,2)
    return [value.detach().numpy().copy() for value in model.state_dict().values()]


def public_delta(node_id):
    import numpy as np
    return [np.full((2,4),(node_id-2)*.125,dtype=np.float32),np.array([node_id*.0625,-node_id*.0625],dtype=np.float32)]


def train_synthetic(parameters,node_id,directory):
    import numpy as np
    import torch
    from torch.utils.data import DataLoader,TensorDataset
    from opacus import PrivacyEngine
    torch.set_num_threads(1)
    rng=np.random.default_rng(20261017+node_id)
    x=rng.normal(size=(16,4)).astype(np.float32);y=(x.sum(axis=1)>0).astype(np.int64)
    with torch.random.fork_rng():
        torch.manual_seed(1729);model=torch.nn.Linear(4,2)
    original=model.state_dict()
    if len(parameters)!=len(original) or any(value.shape!=original[key].shape or not np.isfinite(value).all() for key,value in zip(original,parameters)):
        raise ValueError('The common public base classifier is structurally invalid.')
    model.load_state_dict({key:torch.tensor(value.copy()) for key,value in zip(original,parameters)},strict=True)
    loader=DataLoader(TensorDataset(torch.tensor(x),torch.tensor(y)),batch_size=4,shuffle=False)
    optimizer=torch.optim.SGD(model.parameters(),lr=.05)
    engine=PrivacyEngine(accountant='rdp',secure_mode=False)
    model,optimizer,loader=engine.make_private(module=model,optimizer=optimizer,data_loader=loader,noise_multiplier=1.2,max_grad_norm=1.,poisson_sampling=True)
    receipt=directory/'synthetic-privacy-receipt.json'
    receipt.write_text(json.dumps({'mode':'synthetic_research_only','status':'reserved','planned_logical_steps':len(loader),'secure_rng':False}),encoding='utf8')
    steps=0
    for features,labels in loader:
        optimizer.zero_grad();logits=model(features)
        loss=torch.nn.functional.cross_entropy(logits,labels) if len(labels) else logits.sum()
        loss.backward();optimizer.step();steps+=1
    current=list(model._module.state_dict().values())
    delta=[np.clip(value.detach().numpy()-base,-1.,1.).astype(np.float32) for value,base in zip(current,parameters)]
    history=engine.accountant.history;epsilon=engine.get_epsilon(delta=1e-5)
    if not steps or not np.isfinite(epsilon) or not all(np.isfinite(value).all() for value in delta):raise ValueError('Actual DP execution did not produce valid outputs.')
    value={'mode':'synthetic_research_only','status':'spent','logical_steps':steps,'epsilon':epsilon,'delta':1e-5,'accountant':'rdp','history':history,'secure_rng':False,'encoder_protected':False}
    receipt.write_text(json.dumps(value,indent=2),encoding='utf8')
    return delta,{'logical_steps':steps,'epsilon':epsilon,'accountant_history':json.dumps(history),'secure_rng':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-id',type=int,choices=[1,2,3],required=True)
    parser.add_argument('--mode',choices=['public_vectors','synthetic_dp'],required=True)
    parser.add_argument('--directory',required=True)
    parser.add_argument('--synthetic-only',action='store_true',required=True)
    args=parser.parse_args();directory=Path(args.directory).resolve();expected=Path(__file__).resolve().parents[1]/'.codex-tmp'
    if not directory.is_relative_to(expected.resolve()) or not directory.parent.name.startswith('federated-f00-'):parser.error('F00 nodes require their fresh local synthetic runtime directory.')
    directory.mkdir(exist_ok=True)
    from flwr.client import ClientApp,NumPyClient
    from flwr.client.mod import secaggplus_mod
    from flwr.common import Context,RecordDict
    from flwr.common.serde import message_from_proto,message_to_proto
    from flwr.proto.message_pb2 import Message as ProtoMessage
    class Node(NumPyClient):
        def get_parameters(self,config):return initial_arrays()
        def fit(self,parameters,config):
            if args.mode=='public_vectors':delta,metrics=public_delta(args.node_id),{}
            else:delta,metrics=train_synthetic(parameters,args.node_id,directory)
            return delta,1,{**metrics,'node_pid':os.getpid(),'institution_weight':1}
    app=ClientApp(client_fn=lambda context:Node().to_client(),mods=[secaggplus_mod])
    context=Context(run_id=1,node_id=args.node_id,node_config={},state=RecordDict(),run_config={})
    (directory/'process.json').write_text(json.dumps({'pid':os.getpid(),'parent_pid':os.getppid(),'node_id':args.node_id,'mode':args.mode}),encoding='utf8')
    incoming,outgoing=sys.stdin.buffer,sys.stdout.buffer
    while True:
        try:raw=read_frame(incoming)
        except EOFError:return
        message=message_from_proto(ProtoMessage.FromString(raw))
        if message.metadata.run_id!=1 or message.metadata.dst_node_id!=args.node_id or message.metadata.src_node_id!=0:raise ValueError('Protocol message identity does not match this F00 process.')
        with contextlib.redirect_stdout(sys.stderr):reply=app(message,context)
        proto=message_to_proto(reply);proto.metadata.message_id=uuid4().hex
        write_frame(outgoing,proto.SerializeToString())


if __name__=='__main__':main()
