"""Node signatures, not a user's JWT, establish the local node channel identity."""
import base64
from datetime import datetime,timedelta,timezone
import hashlib
import hmac
import json
from types import SimpleNamespace
from uuid import uuid4
from fastapi import HTTPException
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from backend.app.core.data_encryption import master_key
from backend.app.models.federated import FederatedNodeRuntime
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services import federated_control_service as control

PREFIX='federated-node-challenge.v1.'


def _mac(value):
    return hmac.new(master_key(),b'federated-node-challenge-v1:'+value.encode(),hashlib.sha256).hexdigest()


def _runtime(db,node):
    row=db.get(FederatedNodeRuntime,node.id,populate_existing=True)
    return (row,control._object(db,row)) if row else (None,None)


def challenge(db,node_id):
    control._schema(db);node,_=control._node(db,node_id,admitted=True)
    runtime,state=_runtime(db,node)
    now=datetime.now(timezone.utc);expires=now+timedelta(seconds=60)
    body={'node_id':node.id,'institution_id':node.institution_id,'ledger_key':node.ledger_key,'revision':node.revision,
        'runtime_version':runtime.version if runtime else 0,'sequence':(state['sequence'] if state else 0)+1,
        'issued_at':now.isoformat(),'expires_at':expires.isoformat(),'nonce':uuid4().hex}
    raw=base64.urlsafe_b64encode(json.dumps(body,sort_keys=True,separators=(',',':')).encode()).decode().rstrip('=')
    return {'node_id':node.id,'challenge':PREFIX+raw+'.'+_mac(raw),'next_sequence':body['sequence'],
        'expires_at':expires.isoformat(),'protocol':'ed25519-sha256-canonical-v1'}


def _verify_challenge(value):
    try:
        if not value.startswith(PREFIX):raise ValueError('Wrong domain')
        raw,signature=value[len(PREFIX):].split('.')
        if not hmac.compare_digest(_mac(raw),signature):raise ValueError('Wrong MAC')
        body=json.loads(base64.b64decode(raw+'='*(-len(raw)%4),altchars=b'-_',validate=True))
        now=datetime.now(timezone.utc)
        issued=datetime.fromisoformat(body['issued_at']);expires=datetime.fromisoformat(body['expires_at'])
        if issued.tzinfo is None or expires.tzinfo is None or issued>now+timedelta(seconds=5) or expires<=now or expires-issued>timedelta(seconds=60):raise ValueError('Expired challenge')
        return body
    except (ValueError,TypeError,KeyError) as exc:raise HTTPException(403,'节点挑战已过期、被替换或签名无效。') from exc


def heartbeat(db,payload):
    control._schema(db);node,values=control._node(db,payload.node_id)
    request=control._body(payload);signed={key:value for key,value in request.items() if key!='signature'}
    try:
        signature=base64.b64decode(payload.signature,validate=True)
        load_pem_public_key(values['public_key_pem'].encode()).verify(signature,canonical_digest(signed).encode())
    except (ValueError,TypeError,InvalidSignature) as exc:raise HTTPException(403,'节点原登记公钥无法验证当前请求。') from exc
    actor=SimpleNamespace(id=None)
    old=control._old(db,actor,payload.client_request_id,'node_heartbeat',node.id,request)
    if old:return old
    node,values=control._node(db,node.id,admitted=True)
    head,head_state,_=control._head(db,node.institution_id,lock=True)
    # Re-read after acquiring the institution's mutation lock; a second process
    # cannot consume the same challenge or overwrite a newer heartbeat.
    runtime,state=_runtime(db,node);token=_verify_challenge(payload.challenge)
    if token.get('node_id')!=node.id or token.get('institution_id')!=node.institution_id or token.get('ledger_key')!=node.ledger_key or token.get('revision')!=node.revision:
        raise HTTPException(403,'节点挑战不属于原节点身份版本。')
    if token.get('runtime_version')!=(runtime.version if runtime else 0) or token.get('sequence')!=payload.sequence or payload.sequence!=(state['sequence'] if state else 0)+1:
        raise HTTPException(409,'节点挑战已被使用或状态版本已经改变。')
    if payload.observed_at.tzinfo is None or abs((datetime.now(timezone.utc)-payload.observed_at.astimezone(timezone.utc)).total_seconds())>60:
        raise HTTPException(403,'节点心跳时间不可信或已过期。')
    if payload.compatibility!=values['compatibility']:raise HTTPException(409,'节点运行兼容版本与批准版本不一致。')
    now=datetime.now(timezone.utc)
    if runtime is None:
        runtime=FederatedNodeRuntime(id=node.id,institution_id=node.institution_id,version=0,sealed_payload='');db.add(runtime)
    runtime.version+=1
    runtime.put({'node_id':node.id,'sequence':payload.sequence,'authority':control._core(node),'last_seen_at':now.isoformat(),
        'signed_request':request,'protocol':'ed25519-sha256-canonical-v1'})
    result={'node_id':node.id,'identity_verified':True,'sequence':payload.sequence,'last_heartbeat_at':now.isoformat(),
        'runtime_admitted':False,'notice':'身份已通过；尚须具体模型、输入契约、本地特征及保护预算准入。'}
    return control._append(db,actor,head,head_state,runtime,'node_heartbeat',node.id,request,result)


def runtime_status(db,node):
    runtime,state=_runtime(db,node)
    if state is None:return {'identity_verified':False,'last_heartbeat_at':None,'runtime_admitted':False}
    original=state['authority']
    current=node.ledger_key==original['ledger_key'] and node.revision==original['revision']
    try:control._node(db,node.id,admitted=True)
    except HTTPException as error:
        if error.status_code not in {403,409}:raise
        current=False
    recent=(datetime.now(timezone.utc)-datetime.fromisoformat(state['last_seen_at'])).total_seconds()<120
    return {'identity_verified':bool(current and recent and node.status=='approved'),'last_heartbeat_at':state['last_seen_at'],'runtime_admitted':False}


def original_query(db,payload):
    control._schema(db);node,values=control._node(db,payload.node_id)
    request=control._body(payload);signed={key:value for key,value in request.items() if key!='signature'}
    try:
        load_pem_public_key(values['public_key_pem'].encode()).verify(base64.b64decode(payload.signature,validate=True),canonical_digest(signed).encode())
    except (ValueError,TypeError,InvalidSignature) as error:raise HTTPException(403,'原节点身份无法验证查询签名。') from error
    if payload.requested_at.tzinfo is None or abs((datetime.now(timezone.utc)-payload.requested_at.astimezone(timezone.utc)).total_seconds())>60:
        raise HTTPException(403,'节点原编号查询时间已过期。')
    from sqlalchemy import select
    from backend.app.models.federated import FederatedAuditEvent
    event=db.scalar(select(FederatedAuditEvent).where(FederatedAuditEvent.client_request_id==payload.target_client_request_id))
    if event is None:raise HTTPException(404,'原节点编号尚无已提交记录。')
    control._head(db,event.institution_id);body=event.read()
    if event.actor_user_id is not None or body['operation']!='node_heartbeat' or body['target']!=node.id:
        raise HTTPException(403,'查询编号不属于这个原节点。')
    ack=control._old(db,SimpleNamespace(id=None),payload.target_client_request_id)
    return {'query_id':payload.query_id,'node_id':node.id,'target_client_request_id':payload.target_client_request_id,'operation_receipt':ack}
