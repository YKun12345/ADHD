"""Frozen research experiments; admission and durable controls do not train in HTTP."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
from uuid import uuid4
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.exceptions import InvalidSignature
from backend.app.core.config import settings
from backend.app.models.federated_experiment import FederatedExperiment,FederatedRound,FederatedPrivacyLedger
from backend.app.models.federated import FederatedProjectNode
from backend.app.models.model_registry import ModelRegistryAction
from backend.app.models.consent import ConsentRecord
from backend.app.services import federated_control_service as control
from backend.app.services import model_registry_service as registry
from backend.app.services.identity_access import record_authority,require_research_access
from backend.app.services.care_plan_service import _credentials,_original_credentials
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.schemas.federated_experiment import PRESET
from backend.app.core.record_envelope import RecordIntegrityError

ROOT=Path(__file__).resolve().parents[3]
TERMINAL={'completed','failed','cancelled','budget_exhausted'}


def _research_base(db,identifier,*,admit=False,verify_bytes=True):
    version=registry._version(db,identifier)
    if version.manifest['purpose']!='research_only':raise HTTPException(409,'此实验只接受明确登记为研究用途的基座，不能借临床准入训练。')
    if admit:
        registry._head(db,version.family)
        review=db.scalar(select(ModelRegistryAction).where(ModelRegistryAction.version_id==version.id,ModelRegistryAction.action=='review').order_by(ModelRegistryAction.id.desc()).limit(1))
        if review is None:raise HTTPException(409,'研究基座的代码、权重、数据、用途和输入契约尚未分别核验。')
        checks=review.payload['evidence']
        if any(checks.get(key,{}).get('status')!='verified' or not checks.get(key,{}).get('reference') for key in registry.REQUIRED_REVIEW):
            raise HTTPException(409,'研究基座仍有未核验或拒绝的来源与用途条件。')
        _original_credentials(db,review.authority_snapshot)
    else:review=None
    path=registry.artifact_path(version) if verify_bytes else None
    return version,path,review


def _load(db,identifier):
    control._schema(db);row=db.get(FederatedExperiment,identifier,populate_existing=True)
    if row is None:raise HTTPException(404,'研究实验不存在。')
    values=control._object(db,row)
    at=control._utc(row.lease_expires_at).isoformat() if row.lease_expires_at else None
    expected={'project_id':row.project_id,'actor_user_id':row.actor_user_id,'status':row.status,'revision':row.version,
        'active_slot':row.active_slot,'lease_owner':row.lease_owner,'lease_expires_at':at}
    if values['state']!=expected or values['configuration_digest']!=canonical_digest(values['configuration']):
        raise RecordIntegrityError('Frozen federated configuration or experiment state changed.')
    return row,values


def _put(row,values,*,advance=True):
    if advance:row.version+=1
    values['state']={'project_id':row.project_id,'actor_user_id':row.actor_user_id,'status':row.status,'revision':row.version,
        'active_slot':row.active_slot,'lease_owner':row.lease_owner,
        'lease_expires_at':control._utc(row.lease_expires_at).isoformat() if row.lease_expires_at else None}
    row.put(values)


def _public(row,values):
    return {'id':row.id,'project_id':row.project_id,'actor_user_id':row.actor_user_id,'status':row.status,'revision':row.version,
        'configuration':values['configuration'],'configuration_digest':values['configuration_digest'],
        'completed_rounds':values.get('completed_rounds',0),'preflight':values.get('preflight'),
        'last_error':values.get('last_error'),'candidate_model_version_id':values.get('candidate_model_version_id'),
        'research_only':True,'clinical_activation_allowed':False}


def detail(db,user,identifier):
    row,values=_load(db,identifier);control._scope(db,user,row.project_id)
    return _public(row,values)


def listing(db,user,project_id):
    control._scope(db,user,project_id)
    return {'items':[_public(row,_load(db,row.id)[1]) for row in db.scalars(select(FederatedExperiment).where(FederatedExperiment.project_id==project_id).order_by(FederatedExperiment.id)).all()]}


def create(db,user,project_id,payload):
    request=control._body(payload);old=control._old(db,user,payload.client_request_id,'experiment_create',project_id,request)
    if old:return old
    project,pc,_=control._scope(db,user,project_id,'experiment');control._project(db,project_id,active=True);record_authority(db,pc)
    if len(set(payload.node_ids))!=3 or any(not isinstance(n,str) or not n or len(n)>64 for n in payload.node_ids):raise HTTPException(422,'必须选择三个不同的具体节点。')
    if payload.mode=='synthetic_plaintext' and payload.consent_record_ids:raise HTTPException(422,'明文对照只接受节点合成资料，不能指定患者研究同意。')
    _research_base(db,payload.base_model_version_id,verify_bytes=False)
    head,state,_=control._head(db,project.institution_id,lock=True)
    configuration=payload.model_dump(mode='json',exclude={'client_request_id'});configuration['privacy']=dict(PRESET)
    row=FederatedExperiment(id=uuid4().hex,project_id=project_id,institution_id=project.institution_id,actor_user_id=user.id,
        status='draft',version=1,active_slot=None,lease_owner=None,lease_expires_at=None,sealed_payload='')
    values={'configuration':configuration,'configuration_digest':canonical_digest(configuration),'source_credentials':[],
        'completed_rounds':0,'preflight':None,'last_error':None,'candidate_model_version_id':None,'last_committed_parameters':None}
    _put(row,values,advance=False);db.add(row)
    return control._append(db,user,head,state,row,'experiment_create',project_id,request,_public(row,values),project_id)


def _node_registry():
    if not settings.FEDERATED_NODE_REGISTRY_PATH:raise HTTPException(503,'尚未配置本机独立节点目录清单。')
    path=Path(settings.FEDERATED_NODE_REGISTRY_PATH).expanduser().resolve()
    try:
        if path.stat().st_size>256*1024:raise ValueError('Oversized registry')
        data=json.loads(path.read_text(encoding='utf8'));entries=data['nodes']
        if data.get('schema')!='federated-node-registry/v1' or not isinstance(entries,dict):raise ValueError('Wrong schema')
        return entries
    except (OSError,ValueError,KeyError,TypeError) as error:raise HTTPException(503,'节点本地目录清单不可用或格式不一致。') from error


def _node_source(db,node_id,candidate):
    node,identity=control._node(db,node_id,admitted=True)
    entries=_node_registry();entry=entries.get(node_id)
    if not isinstance(entry,dict) or not isinstance(entry.get('directory'),str):raise HTTPException(409,'节点尚未在本机目录清单登记。')
    root=Path(settings.FEDERATED_NODE_ROOT).resolve();directory=Path(entry['directory']).resolve()
    if directory==root or not directory.is_relative_to(root) or not directory.is_dir():raise HTTPException(409,'节点目录不在配置的独立节点根目录内。')
    try:
        manifest_file=directory/'manifest.json';metadata_file=directory/'features.metadata.json'
        if manifest_file.stat().st_size>512*1024 or metadata_file.stat().st_size>512*1024:raise ValueError('Oversized node metadata')
        manifest_bytes=manifest_file.read_bytes();signed=json.loads(metadata_file.read_text(encoding='utf8'));manifest=json.loads(manifest_bytes);body=signed['payload']
        from federated_runtime.hgst_features import canonical_json
        key=load_pem_public_key(identity['public_key_pem'].encode());key.verify(bytes.fromhex(signed['signature_hex']),canonical_json(body))
        if body['node_id']!=node_id or manifest['node_id']!=node_id or manifest.get('synthetic') is not True or manifest.get('mode')!='synthetic_research_only':raise ValueError('Wrong node/mode')
        if body['manifest_sha256']!=hashlib.sha256(manifest_bytes).hexdigest() or body['candidate_sha256']!=candidate.artifact_sha256 or manifest['candidate_sha256']!=candidate.artifact_sha256:raise ValueError('Wrong original manifest/base')
        if body['node_public_key_sha256']!=node.public_key_fingerprint or body['protection_namespace']!=manifest['protection_namespace']:raise ValueError('Wrong public identity/protection scope')
        if body['input_contract_sha256']!=candidate.manifest['input_contract_digest']:raise ValueError('Wrong numerical input contract')
        for key_name,file in (('modeling_code_sha256','modeling.py'),('preprocessing_code_sha256','preprocessing.py')):
            if body[key_name]!=hashlib.sha256((ROOT/'backend/app/services/hgst_runtime'/file).read_bytes()).hexdigest():raise ValueError('Feature code changed')
        names=['linear1.weight','linear1.bias','linear2.weight','linear2.bias'];descriptors=body['classifier_parameters']
        if [d['name'] for d in descriptors]!=names or any(d['dtype']!='float32' for d in descriptors):raise ValueError('Wrong four-array classifier schema')
        count=sum(__import__('math').prod(d['shape']) for d in descriptors)
        if count<=0 or count>4_000_000:raise ValueError('Classifier exceeds this prototype memory cap')
    except (OSError,KeyError,ValueError,TypeError,InvalidSignature) as error:raise HTTPException(409,'节点本地特征签名、基座、输入契约或资源条件未通过。') from error
    return {'node_id':node_id,'institution_id':node.institution_id,'directory':str(directory),'public_key_pem':identity['public_key_pem'],
        'node_ledger_key':node.ledger_key,'node_revision':node.revision,'protection_namespace':body['protection_namespace'],
        'metadata_sha256':hashlib.sha256(metadata_file.read_bytes()).hexdigest(),'config_sha256':body['config_sha256'],
        'encoder_parameters_sha256':body['encoder_parameters_sha256'],'classifier_parameters':descriptors,
        'feature_dimension':body['feature_dimension'],'encoder_origin':body['encoder_origin']}


def _histories(db):
    histories=[]
    for row in db.scalars(select(FederatedPrivacyLedger)).all():
        values=control._object(db,row)
        if values['protection_namespace']!=row.protection_namespace:raise RecordIntegrityError('Privacy namespace changed.')
        for reservation in values['reservations']:
            histories.append([reservation['noise_multiplier'],reservation['sample_rate'],reservation['planned_steps']])
    return histories


def account(histories):
    interpreter=Path(settings.FEDERATED_PYTHON).resolve()
    if not interpreter.is_file():raise HTTPException(503,'隔离联邦训练解释器尚不可用。')
    try:
        process=subprocess.run([str(interpreter),'-m','federated_runtime.accountant'],input=json.dumps({'histories':histories,'delta':PRESET['delta']}),
            cwd=ROOT,text=True,capture_output=True,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0,
            env={**os.environ,'FLWR_TELEMETRY_ENABLED':'0'})
        result=json.loads(process.stdout) if process.returncode==0 else None
        if not isinstance(result,dict) or result.get('accountant')!='rdp':raise ValueError('No exact accountant result')
        return result
    except (ValueError,OSError,subprocess.TimeoutExpired) as error:raise HTTPException(503,'隔离环境的实际RDP账本预检未完成。') from error


def _sources(db,user,row,values,*,fresh_heartbeat=True):
    control._scope(db,user,row.project_id,'experiment');project,pc,_=control._project(db,row.project_id,active=True);record_authority(db,pc)
    config=values['configuration'];candidate,path,review=_research_base(db,config['base_model_version_id'],admit=True)
    if config['mode']=='synthetic_plaintext' and config['consent_record_ids']:
        raise HTTPException(409,'明文对照只能使用节点合成资料，不能附带患者研究同意作为真实资料入口。')
    roster=control.detail(db,user,row.project_id)['nodes'];eligible={n['id']:n for n in roster if n['effective_status']=='approved'}
    nodes=[]
    from backend.app.services.federated_node_service import runtime_status
    for index,node_id in enumerate(config['node_ids'],1):
        link=eligible.get(node_id)
        if link is None:raise HTTPException(409,'三个选定节点尚未全部通过具体项目的原审批。')
        node,_=control._node(db,node_id,admitted=True)
        if fresh_heartbeat and not runtime_status(db,node)['identity_verified']:raise HTTPException(409,'节点尚无近期有效的独立身份心跳。')
        item=_node_source(db,node_id,candidate);item.update(index=index,link_id=link['link_id'],link_revision=link['link_revision']);nodes.append(item)
    if len({n['institution_id'] for n in nodes})!=3:raise HTTPException(409,'当前三节点模式要求三个分别获准的机构，不能把同院多个进程充当三机构。')
    if len({(n['config_sha256'],n['encoder_parameters_sha256'],canonical_digest(n['classifier_parameters'])) for n in nodes})!=1:
        raise HTTPException(409,'三个节点的编码器、配置和分类器参数结构不一致。')
    for consent_id in config['consent_record_ids']:
        consent=db.get(ConsentRecord,consent_id,populate_existing=True)
        if consent is None or consent.project_id!=row.project_id:raise HTTPException(403,'指定同意不属于当前具体研究项目。')
        require_research_access(db,user.id,consent.patient_id,row.project_id,'imaging')
        from backend.app.services.consent_service import current_consent
        if current_consent(db,consent.patient_id,'research',project_id=row.project_id).id!=consent.id:raise HTTPException(409,'指定研究同意已被替代，不能借用新同意。')
    return {'project_authority':control._core(pc),'base_version_id':candidate.id,'base_sha256':candidate.artifact_sha256,
        'base_path':str(path),'base_review_id':review.id,'input_contract_digest':candidate.manifest['input_contract_digest'],
        'nodes':nodes,'credentials':_credentials(db)}


def worker_sources(db,row,values):
    """Recheck the exact original grants and source bytes at every worker gate."""
    from backend.app.models.user import User
    _original_credentials(db,values['source_credentials'])
    user=db.get(User,row.actor_user_id,populate_existing=True)
    if user is None:raise HTTPException(403,'原实验发起账号已不存在。')
    sources=_sources(db,user,row,values)
    if canonical_digest({k:v for k,v in sources.items() if k!='credentials'})!=canonical_digest({k:v for k,v in values['sources'].items() if k!='credentials'}):
        raise HTTPException(409,'实验的原项目、成员、节点、同意、模型或签名来源已经改变。')
    return sources


def action(db,user,identifier,payload,operation):
    request=control._body(payload);old=control._old(db,user,payload.client_request_id,'experiment_'+operation,identifier,request)
    if old:return old
    row,values=_load(db,identifier);control._scope(db,user,row.project_id,'experiment')
    head,state,_=control._head(db,row.institution_id,lock=True);row,values=_load(db,identifier)
    if row.version!=payload.expected_revision:raise HTTPException(409,'实验状态版本已改变，请重新读取。')
    if operation=='preflight':
        if row.status not in {'draft','ready'}:raise HTTPException(409,'当前实验不能重新预检；配置修改须新建实验。')
        sources=_sources(db,user,row,values)
        protected=values['configuration']['mode']=='dp_secagg'
        history=_histories(db);planned=[[PRESET['noise_multiplier'],PRESET['sample_rate'],PRESET['logical_steps']*values['configuration']['rounds']] for _ in sources['nodes']] if protected else []
        projected=account(history+planned)
        if protected and projected['epsilon']>PRESET['max_epsilon']:raise HTTPException(409,'整体保守顺序组合预算不足；不能重置项目、任务或节点账本。')
        values['sources']=sources;values['source_credentials']=sources['credentials']
        values['preflight']={'status':'passed','projected_privacy':projected,'preset':dict(PRESET),'node_count':3,
            'encoder_origin':sources['nodes'][0]['encoder_origin'],'encoder_dp_protected':False,'secure_rng':False,'real_data_allowed':False,
            'mode':values['configuration']['mode'],'dp_enabled':protected,'secagg_enabled':protected,
            'notice':'仅合成研究。明文对照没有DP或安全聚合保护；显示的既有DP预算不代表明文对照受到保护。' if not protected else 'DP仅保护分类器更新。'}
        row.status='ready'
    elif operation=='start':
        if row.status not in {'ready'}:raise HTTPException(409,'只有完成当前真实准入预检的实验可以开始。')
        if values['configuration']['mode'] not in {'dp_secagg','synthetic_plaintext'}:raise HTTPException(409,'未支持的实验模式。')
        _original_credentials(db,values['source_credentials']);current=_sources(db,user,row,values)
        if canonical_digest(current)!=canonical_digest(values['sources']):raise HTTPException(409,'实验的原节点、模型或授权来源已经改变。')
        if not settings.FEDERATED_WORKER_ENABLED:raise HTTPException(503,'后台联邦执行器尚未明确启用，实验仍保留为ready。')
        row.status='queued';row.active_slot=1
        try:db.flush()
        except IntegrityError as error:
            db.rollback();raise HTTPException(409,'当前已有一个实验运行或等待安全停止。') from error
    elif operation=='stop':
        if row.status in TERMINAL:raise HTTPException(409,'实验已结束，不能改写终态。')
        row.status='stopping' if row.status in {'running','validating','stopping'} else 'cancelled'
        if row.status=='cancelled':row.active_slot=None
    else:raise ValueError(operation)
    _put(row,values)
    return control._append(db,user,head,state,row,'experiment_'+operation,identifier,request,_public(row,values),row.project_id)


def rounds(db,user,identifier):
    experiment,_=_load(db,identifier);control._scope(db,user,experiment.project_id)
    items=[]
    for row in db.scalars(select(FederatedRound).where(FederatedRound.experiment_id==identifier).order_by(FederatedRound.round_number,FederatedRound.id)).all():
        values=control._object(db,row)
        if values['experiment_id']!=identifier or values['round_number']!=row.round_number or values['attempt']!=row.attempt or values['status']!=row.status:
            raise RecordIntegrityError('Federated round routing or phase changed.')
        items.append({key:value for key,value in values.items() if key not in {'runtime_manifest','receipt_path','aggregate_path'}})
    return {'experiment_id':identifier,'items':items}


def privacy(db,user,project_id):
    control._scope(db,user,project_id)
    return {'project_id':project_id,'overall':account(_histories(db)),'maximum_epsilon':PRESET['max_epsilon'],
        'maximum_delta':PRESET['delta'],'composition':'conservative_sequential_all_institutions',
        'secure_rng':False,'encoder_dp_protected':False,'real_data_allowed':False,
        'notice':'保守预留及未确认消耗持续计入；变更项目不会重置账本。'}
