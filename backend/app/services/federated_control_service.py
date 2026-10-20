"""Persistent institution/project controls. Training is performed by a separate worker."""
from datetime import datetime,timezone
import hashlib
from uuid import uuid4
from fastapi import HTTPException
from sqlalchemy import select,inspect
from cryptography.hazmat.primitives.serialization import load_pem_public_key,Encoding,PublicFormat
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from backend.app.models.federated import (FederatedProject,FederatedProjectMember,FederatedNode,
    FederatedProjectNode,FederatedAuditHead,FederatedAuditEvent,FederatedConsentReceipt,FederatedConsentBinding,FederatedNodeRuntime)
from backend.app.models.identity import ResearchProject,ResearchProjectMember
from backend.app.models.federated_experiment import FederatedExperiment,FederatedRound,FederatedParticipation,FederatedPrivacyLedger,FederatedModelVersion
from backend.app.models.user import User
from backend.app.services import authorization_ledger as ledger
from backend.app.services.identity_access import (require_reviewer,active_memberships,not_expired,
    record_authority,recheck_request_authority,publish_authority,identity_basis)
from backend.app.services.care_plan_service import _credentials,_original_credentials
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.core.record_envelope import RecordIntegrityError

TABLES=(FederatedProject,FederatedProjectMember,FederatedNode,FederatedProjectNode,FederatedAuditHead,FederatedConsentReceipt,FederatedConsentBinding,FederatedNodeRuntime,FederatedExperiment,FederatedRound,FederatedParticipation,FederatedPrivacyLedger,FederatedModelVersion,FederatedAuditEvent)


def _schema(db):
    names=set(inspect(db.connection()).get_table_names())
    if any(m.__tablename__ not in names for m in TABLES):
        raise HTTPException(503,'联邦项目结构尚未按授权准备；不会自动迁移真实数据库。')


def _body(payload):
    from copy import deepcopy
    return deepcopy(payload._request_snapshot)


def _utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _core(row):
    result={k:getattr(row,k) for k in ('id','ledger_key','revision','status')}
    result['expires_at']=row.expires_at.isoformat() if row.expires_at else None
    if isinstance(row,ResearchProject):result['name']=row.name
    return result


def _verify_core(row,snapshot):
    # SQLite strips timezone information; timestamps are compared as UTC instants.
    expected=dict(snapshot);current=_core(row)
    for value in (expected,current):
        stamp=value.get('expires_at')
        if stamp:
            instant=datetime.fromisoformat(stamp)
            value['expires_at']=(instant.replace(tzinfo=timezone.utc) if instant.tzinfo is None else instant.astimezone(timezone.utc)).isoformat()
    if current!=expected:raise RecordIntegrityError('The original research authority was changed outside its authenticated object.')
    if not ledger.matches(row,active=row.status in {'active','approved'}):
        raise HTTPException(409,'研究权威行与独立撤销账本不一致。')


def _head(db,institution_id,*,create=False,lock=False):
    query=select(FederatedAuditHead).where(FederatedAuditHead.id==institution_id).execution_options(populate_existing=True)
    if lock:query=query.with_for_update()
    head=db.scalar(query)
    if head is None:
        if not create:raise HTTPException(503,'联邦机构审计链头缺失，禁止从业务备份重建。')
        head=FederatedAuditHead(id=institution_id,institution_id=institution_id,version=1,revision=1,
            ledger_key='fed-audit-'+hashlib.sha256(institution_id.encode()).hexdigest()[:48],sealed_payload='')
        head.put({'revision':1,'ledger_key':head.ledger_key,'sequence':0,'last_hash':''})
        ledger.reserve(head);db.add(head);db.flush()
        return head,head.read(),[]
    state=head.read()
    if head.institution_id!=head.id or state.get('revision')!=head.revision or state.get('ledger_key')!=head.ledger_key or not ledger.matches(head):
        raise HTTPException(503,'联邦审计链头认证或独立单调锚点不一致。')
    previous='';events=[]
    rows=db.scalars(select(FederatedAuditEvent).where(FederatedAuditEvent.institution_id==institution_id).order_by(FederatedAuditEvent.sequence).execution_options(populate_existing=True)).all()
    for sequence,event in enumerate(rows,1):
        body=event.read()
        at=event.created_at.replace(tzinfo=timezone.utc) if event.created_at.tzinfo is None else event.created_at.astimezone(timezone.utc)
        if event.sequence!=sequence or body.get('sequence')!=sequence or body.get('previous')!=previous or body.get('actor_user_id')!=event.actor_user_id or body.get('project_id')!=event.project_id or body.get('client_request_id')!=event.client_request_id or body.get('created_at')!=at.isoformat():
            raise RecordIntegrityError('Federated audit sequence, routing or original actor changed.')
        previous=hashlib.sha256(event.sealed_payload.encode()).hexdigest();events.append((event,body))
    if len(rows)!=state['sequence'] or previous!=state['last_hash']:
        raise HTTPException(503,'联邦审计链被截断或替换；保留原件并停止操作。')
    return head,state,events


def _object(db,row):
    _,_,events=_head(db,row.institution_id)
    body=row.read()
    latest=next((payload for _,payload in reversed(events) if payload.get('object_type')==row.__tablename__ and payload.get('object_id')==str(row.id)),None)
    if latest is None or latest['object_digest']!=hashlib.sha256(row.sealed_payload.encode()).hexdigest():
        raise RecordIntegrityError('Federated object differs from its current independently anchored event.')
    return body


def _project(db,project_id,*,active=False):
    _schema(db);row=db.get(FederatedProject,project_id,populate_existing=True)
    if row is None:raise HTTPException(404,'研究项目不存在。')
    payload=_object(db,row);core=db.get(ResearchProject,project_id,populate_existing=True)
    if core is None or payload.get('owner_user_id')!=row.owner_user_id or payload.get('client_request_id')!=row.client_request_id:
        raise RecordIntegrityError('Federated project identity changed.')
    _verify_core(core,payload['authority'])
    if active:
        if core.status!='active' or not not_expired(core.expires_at):raise HTTPException(403,'具体研究项目已过期、未批准或已撤销。')
        _original_credentials(db,payload['approval_credentials'])
    return row,core,payload


def _member(db,user,project,permission='view'):
    core=db.scalar(select(ResearchProjectMember).where(ResearchProjectMember.project_id==project.id,ResearchProjectMember.user_id==user.id).execution_options(populate_existing=True))
    row=db.get(FederatedProjectMember,core.id,populate_existing=True) if core else None
    if row is None:raise HTTPException(403,'需要这个具体项目的有效成员权限。')
    payload=_object(db,row);_verify_core(core,payload['authority'])
    if row.project_id!=project.id or row.user_id!=user.id or payload.get('project_id')!=project.id or payload.get('user_id')!=user.id:
        raise RecordIntegrityError('Federated membership routing changed.')
    if core.status!='active' or not not_expired(core.expires_at) or permission not in payload['permissions']:
        raise HTTPException(403,'项目成员已过期、已撤销或没有此操作权限。')
    _bound_project(db,project.id,payload.get('project_authority'))
    _original_credentials(db,payload['grant_credentials']);record_authority(db,core)
    return row,core,payload


def _scope(db,user,project_id,permission='view',*,management=False):
    row,core,payload=_project(db,project_id)
    if management:
        require_reviewer(db,user.id,row.institution_id)
    elif active_memberships(db,user.id,'reviewer') and any(m.institution_id==row.institution_id for m in active_memberships(db,user.id,'reviewer')):
        require_reviewer(db,user.id,row.institution_id)
    else:
        _project(db,project_id,active=True);_member(db,user,row,permission)
    return row,core,payload


def _revision(row,expected):
    if row.revision!=expected:raise HTTPException(409,'对象版本已经改变，请重新读取并确认。')


def _old(db,user,client_id,operation=None,target=None,request=None):
    _schema(db)
    event=db.scalar(select(FederatedAuditEvent).where(FederatedAuditEvent.client_request_id==client_id))
    if event is None:return None
    if event.actor_user_id!=user.id:raise HTTPException(403,'原操作不属于当前账号。')
    _head(db,event.institution_id);payload=event.read()
    if operation is not None and (payload['operation']!=operation or payload['target']!=str(target) or payload['original_request']!=request):
        raise HTTPException(409,'原请求编号已经保存了不同的操作、对象或内容。')
    return {'id':event.id,'actor_user_id':event.actor_user_id,'client_request_id':event.client_request_id,'original_request':payload['original_request'],
            'result':payload['result'],'submission_status':'committed'}


def submission(db,user,client_id):
    result=_old(db,user,client_id)
    if result is None:raise HTTPException(404,'原编号尚无已提交记录。')
    return result


def _append(db,user,head,state,obj,operation,target,request,result,project_id=None,activate=()):
    event=FederatedAuditEvent(id=uuid4().hex,institution_id=head.id,version=1,
        sequence=state['sequence']+1,actor_user_id=user.id,project_id=project_id,
        client_request_id=request['client_request_id'],sealed_payload='',created_at=datetime.now(timezone.utc))
    event.put({'sequence':event.sequence,'previous':state['last_hash'],'actor_user_id':user.id,
        'project_id':project_id,'client_request_id':event.client_request_id,'created_at':event.created_at.isoformat(),'operation':operation,'target':str(target),
        'original_request':request,'result':result,'object_type':obj.__tablename__,'object_id':str(obj.id),
        'object_digest':hashlib.sha256(obj.sealed_payload.encode()).hexdigest(),'authority_snapshot':_credentials(db)})
    ledger.deny(head);head.version=head.revision
    head.put({'revision':head.revision,'ledger_key':head.ledger_key,'sequence':event.sequence,
              'last_hash':hashlib.sha256(event.sealed_payload.encode()).hexdigest()})
    db.add(event)
    from backend.app.services.security_service import _append_audit_log
    _append_audit_log(db,action='federated_'+operation,status='success',actor_user_id=user.id,
        message='联邦项目、成员或节点权限操作。',detail_json={'event_id':event.id,'institution_id':head.id,'project_id':project_id,'operation':operation})
    recheck_request_authority(db);db.commit()
    for authority in activate:publish_authority(db,authority)
    # Publication checks the exact original initiating credentials again.
    publish_authority(db,head)
    return {'id':event.id,'actor_user_id':event.actor_user_id,'client_request_id':event.client_request_id,'original_request':request,'result':result,'submission_status':'committed'}


def _project_public(row,core,payload):
    return {'id':row.id,'institution_id':row.institution_id,'owner_user_id':row.owner_user_id,
        'name':payload['name'],'purpose':payload['purpose'],'mode':payload['mode'],'data_contract':payload['data_contract'],
        'status':core.status,'revision':core.revision,'expires_at':payload['authority']['expires_at'],
        'clinical_activation_allowed':False,'runtime_ready':False}


def create_project(db,user,payload):
    request=_body(payload);require_reviewer(db,user.id,payload.institution_id);_schema(db)
    old=_old(db,user,payload.client_request_id,'project_create',payload.institution_id,request)
    if old:return old['result']
    if payload.expires_at.tzinfo is None or not not_expired(payload.expires_at):raise HTTPException(422,'项目有效期必须是带时区的未来时间。')
    head,state,_=_head(db,payload.institution_id,create=True,lock=True)
    core=ResearchProject(name=payload.name,status='pending',expires_at=_utc(payload.expires_at),ledger_key='fed-project-'+uuid4().hex)
    db.add(core);db.flush();ledger.reserve(core)
    row=FederatedProject(id=core.id,institution_id=payload.institution_id,owner_user_id=user.id,
        client_request_id=payload.client_request_id,version=1,sealed_payload='')
    values={**request,'owner_user_id':user.id,'authority':_core(core),'approval_credentials':[]}
    row.put(values);db.add(row);db.flush();result=_project_public(row,core,values)
    _append(db,user,head,state,row,'project_create',payload.institution_id,request,result,core.id)
    return result


def project_action(db,user,project_id,payload,operation):
    request=_body(payload);old=_old(db,user,payload.client_request_id,operation,project_id,request)
    if old:return old
    row,core,values=_scope(db,user,project_id,management=True)
    head,state,_=_head(db,row.institution_id,lock=True)
    row,core,values=_project(db,project_id);_revision(core,payload.expected_revision)
    if operation=='project_approve':
        if core.status not in {'pending','active'} or not not_expired(core.expires_at):raise HTTPException(409,'已撤销或到期项目不能重新批准。')
        ledger.deny(core);core.status='active';values['approval_credentials']=_credentials(db)
        activate=(core,)
    elif operation=='project_revoke':
        if core.status=='revoked':raise HTTPException(409,'项目已撤销。')
        ledger.deny(core);core.status='revoked';activate=()
    else:raise ValueError(operation)
    row.version+=1;values['authority']=_core(core);row.put(values)
    return _append(db,user,head,state,row,operation,project_id,request,_project_public(row,core,values),project_id,activate)


def member_action(db,user,project_id,payload,*,revoke_user_id=None):
    operation='member_revoke' if revoke_user_id else 'member_grant';request=_body(payload)
    target=f'{project_id}:{revoke_user_id}' if revoke_user_id else str(project_id)
    old=_old(db,user,payload.client_request_id,operation,target,request)
    if old:return old
    project,pc,pv=_scope(db,user,project_id,management=True)
    head,state,_=_head(db,project.institution_id,lock=True)
    project,pc,pv=_project(db,project_id,active=True);_revision(pc,payload.expected_revision)
    uid=revoke_user_id or payload.user_id
    core=db.scalar(select(ResearchProjectMember).where(ResearchProjectMember.project_id==project_id,ResearchProjectMember.user_id==uid).with_for_update())
    row=db.get(FederatedProjectMember,core.id) if core else None
    if row:_verify_core(core,_object(db,row)['authority'])
    if revoke_user_id:
        if row is None or core.status!='active':raise HTTPException(409,'没有可撤销的当前项目成员。')
        ledger.deny(core);core.status='revoked';values=row.read();activate=()
    else:
        target_user=db.get(User,uid)
        if target_user is None or not target_user.is_active:raise HTTPException(404,'目标账号不存在或已停用。')
        if payload.expires_at.tzinfo is None or not not_expired(payload.expires_at) or _utc(payload.expires_at)>_utc(pc.expires_at):
            raise HTTPException(422,'成员有效期必须在项目有效期以内。')
        memberships=[m for role in ('researcher','reviewer','clinician') for m in active_memberships(db,uid,role) if m.institution_id==project.institution_id]
        if not memberships:raise HTTPException(403,'成员须有项目所属机构的独立核验身份。')
        for membership in memberships:record_authority(db,membership)
        if core is None:
            core=ResearchProjectMember(project_id=project_id,user_id=uid,status='active',expires_at=_utc(payload.expires_at),ledger_key='fed-member-'+uuid4().hex)
            db.add(core);db.flush();ledger.reserve(core)
        else:ledger.deny(core);core.status='active';core.expires_at=_utc(payload.expires_at)
        if row is None:
            row=FederatedProjectMember(id=core.id,project_id=project_id,user_id=uid,institution_id=project.institution_id,version=0,sealed_payload='');db.add(row)
        values={'project_id':project_id,'user_id':uid,'permissions':sorted(set(payload.permissions)|{'view'}),'grant_credentials':_credentials(db),'project_authority':_core(pc)}
        activate=(core,)
    row.version+=1;values['authority']=_core(core);row.put(values)
    result={'id':core.id,'project_id':project_id,'user_id':uid,'status':core.status,'revision':core.revision,'permissions':values['permissions'],'expires_at':values['authority']['expires_at']}
    return _append(db,user,head,state,row,operation,target,request,result,project_id,activate)


def _node(db,node_id,*,admitted=False):
    row=db.get(FederatedNode,node_id,populate_existing=True)
    if row is None:raise HTTPException(404,'研究节点不存在。')
    values=_object(db,row);_verify_core(row,values['authority'])
    if values['fingerprint']!=row.public_key_fingerprint or values['registered_by']!=row.registered_by:raise RecordIntegrityError('Federated node identity changed.')
    if admitted:
        if row.status!='approved' or not not_expired(row.expires_at):raise HTTPException(403,'节点尚未批准、已过期或已撤销。')
        _original_credentials(db,values['approval_credentials'])
        record_authority(db,row)
    return row,values


def _node_public(row,values,db=None):
    result={'id':row.id,'institution_id':row.institution_id,'name':values['name'],'public_key_fingerprint':row.public_key_fingerprint,
            'compatibility':values['compatibility'],'status':row.status,'revision':row.revision,
            'runtime_admitted':False,'identity_verified':False,'last_heartbeat_at':None}
    if db is not None:
        from backend.app.services.federated_node_service import runtime_status
        result.update(runtime_status(db,row))
    return result


def enroll_node(db,user,payload):
    request=_body(payload);require_reviewer(db,user.id,payload.institution_id);_schema(db)
    old=_old(db,user,payload.client_request_id,'node_enroll',payload.institution_id,request)
    if old:return old['result']
    try:
        key=load_pem_public_key(payload.public_key_pem.encode())
        if not isinstance(key,Ed25519PublicKey):raise ValueError('Expected Ed25519')
        fingerprint=hashlib.sha256(key.public_bytes(Encoding.Raw,PublicFormat.Raw)).hexdigest()
    except (ValueError,TypeError) as exc:raise HTTPException(422,'节点只登记有效Ed25519公钥；中央不接收私钥。') from exc
    if db.scalar(select(FederatedNode.id).where(FederatedNode.public_key_fingerprint==fingerprint)):raise HTTPException(409,'此公钥已登记，不能作为另一个独立机构节点。')
    if payload.node_id and db.get(FederatedNode,payload.node_id):raise HTTPException(409,'节点编号已经登记，不能替换它的原公钥。')
    head,state,_=_head(db,payload.institution_id,create=True,lock=True)
    row=FederatedNode(id=payload.node_id or uuid4().hex,institution_id=payload.institution_id,version=1,
        public_key_fingerprint=fingerprint,registered_by=user.id,status='pending',sealed_payload='')
    db.add(row);db.flush();ledger.reserve(row)
    values={**request,'fingerprint':fingerprint,'registered_by':user.id,'authority':_core(row),'approval_credentials':[]}
    row.put(values);result=_node_public(row,values)
    _append(db,user,head,state,row,'node_enroll',payload.institution_id,request,result)
    return result


def node_action(db,user,node_id,payload,operation):
    request=_body(payload);old=_old(db,user,payload.client_request_id,operation,node_id,request)
    if old:return old
    row,values=_node(db,node_id);require_reviewer(db,user.id,row.institution_id)
    head,state,_=_head(db,row.institution_id,lock=True);row,values=_node(db,node_id);_revision(row,payload.expected_revision)
    if operation=='node_approve':
        if row.status!='pending':raise HTTPException(409,'只有待审核节点可以批准；撤销身份不能重新启用。')
        ledger.deny(row);row.status='approved';values['approval_credentials']=_credentials(db);activate=(row,)
    elif operation=='node_revoke':
        if row.status=='revoked':raise HTTPException(409,'节点已撤销。')
        ledger.deny(row);row.status='revoked';activate=()
    else:raise ValueError(operation)
    row.version+=1;values['authority']=_core(row);row.put(values)
    # No F03 experiment can run yet; its worker will use this same current head.
    return _append(db,user,head,state,row,operation,node_id,request,_node_public(row,values),activate=activate)


def project_node(db,user,project_id,payload):
    request=_body(payload);old=_old(db,user,payload.client_request_id,'node_link',project_id,request)
    if old:return old
    project,core,values=_scope(db,user,project_id,management=True)
    head,state,_=_head(db,project.institution_id,lock=True)
    project,core,values=_project(db,project_id,active=True);_revision(core,payload.expected_revision)
    node,nv=_node(db,payload.node_id,admitted=True)
    row=db.scalar(select(FederatedProjectNode).where(FederatedProjectNode.project_id==project_id,FederatedProjectNode.node_id==node.id).with_for_update())
    if row:
        if _object(db,row)['status']!='revoked':raise HTTPException(409,'此节点已有项目权限；须明确撤销旧权限后才能重新邀请。')
        row.version+=1
    else:row=FederatedProjectNode(id=uuid4().hex,project_id=project_id,node_id=node.id,institution_id=project.institution_id,version=1,sealed_payload='')
    status='approved' if node.institution_id==project.institution_id else 'pending'
    row.put({'project_id':project_id,'node_id':node.id,'weight':1,'node_ledger_key':node.ledger_key,'node_revision':node.revision,
        'status':status,'project_authority':_core(core),'grant_credentials':_credentials(db),'acceptance_credentials':_credentials(db) if status=='approved' else []})
    db.add(row)
    return _append(db,user,head,state,row,'node_link',project_id,request,{'id':row.id,'project_id':project_id,'node_id':node.id,'weight':1,'status':status,'revision':row.version},project_id)


def project_node_decision(db,user,project_id,link_id,payload,*,revoke=False):
    operation='node_link_revoke' if revoke else 'node_link_approve';request=_body(payload)
    target=f'{project_id}:{link_id}';old=_old(db,user,payload.client_request_id,operation,target,request)
    if old:return old
    row=db.get(FederatedProjectNode,link_id)
    if row is None or row.project_id!=project_id:raise HTTPException(404,'项目节点邀请不存在。')
    values=_object(db,row);node,nv=_node(db,row.node_id);project,pc,pv=_project(db,project_id)
    memberships=active_memberships(db,user.id,'reviewer')
    allowed={node.institution_id,project.institution_id} if revoke else {node.institution_id}
    reviewer=next((m for m in memberships if m.institution_id in allowed),None)
    if reviewer is None:raise HTTPException(403,'只有受邀节点所属机构可接受，任一实际参与机构可撤销。')
    require_reviewer(db,user.id,reviewer.institution_id)
    head,state,_=_head(db,project.institution_id,lock=True)
    values=_object(db,row)
    if row.version!=payload.expected_revision:raise HTTPException(409,'节点邀请版本已经改变。')
    if revoke:
        if values['status']=='revoked':raise HTTPException(409,'此节点项目权限已撤销。')
        values['status']='revoked'
    else:
        if values['status']!='pending':raise HTTPException(409,'只有待接受的邀请可以批准。')
        _project(db,project_id,active=True);_node(db,node.id,admitted=True);_original_credentials(db,values['grant_credentials'])
        _bound_project(db,project_id,values.get('project_authority'))
        if node.revision!=values['node_revision'] or node.ledger_key!=values['node_ledger_key']:raise HTTPException(409,'邀请的原节点身份已经改变。')
        values['status']='approved';values['acceptance_credentials']=_credentials(db)
    row.version+=1;row.put(values)
    result={'id':row.id,'project_id':project_id,'node_id':node.id,'weight':1,'status':values['status'],'revision':row.version}
    return _append(db,user,head,state,row,operation,target,request,result,project_id)


def detail(db,user,project_id):
    row,core,values=_scope(db,user,project_id);result=_project_public(row,core,values)
    result['members']=[];result['nodes']=[]
    for member in db.scalars(select(FederatedProjectMember).where(FederatedProjectMember.project_id==project_id)).all():
        body=_object(db,member);authority=db.get(ResearchProjectMember,member.id,populate_existing=True);_verify_core(authority,body['authority'])
        result['members'].append({'user_id':member.user_id,'status':authority.status,'revision':authority.revision,'permissions':body['permissions'],'expires_at':body['authority']['expires_at']})
    for link in db.scalars(select(FederatedProjectNode).where(FederatedProjectNode.project_id==project_id)).all():
        body=_object(db,link)
        if body['project_id']!=project_id or body['node_id']!=link.node_id:raise RecordIntegrityError('Federated whitelist routing changed.')
        node,nv=_node(db,link.node_id)
        status=body['status'] if body['status']!='approved' else node.status
        if node.status=='approved' and body['status']=='approved':
            try:_node(db,node.id,admitted=True);_bound_project(db,project_id,body.get('project_authority'));_original_credentials(db,body['grant_credentials']);_original_credentials(db,body['acceptance_credentials'])
            except HTTPException:status='authority_invalid'
            if node.revision!=body['node_revision'] or node.ledger_key!=body['node_ledger_key']:status='authority_invalid'
        result['nodes'].append({**_node_public(node,nv,db),'weight':body['weight'],'effective_status':status,'link_id':link.id,'link_revision':link.version})
    return result


def listing(db,user):
    _schema(db);reviewers={m.institution_id for m in active_memberships(db,user.id,'reviewer')}
    member_projects=set(db.scalars(select(ResearchProjectMember.project_id).where(ResearchProjectMember.user_id==user.id)).all())
    projects=[]
    for row in db.scalars(select(FederatedProject).order_by(FederatedProject.id)).all():
        if row.institution_id not in reviewers and row.id not in member_projects:continue
        try:
            project,core,values=_scope(db,user,row.id);projects.append(_project_public(project,core,values))
        except HTTPException as exc:
            if exc.status_code!=403:raise
    nodes=[];invitations=[]
    for institution in reviewers:
        require_reviewer(db,user.id,institution)
        for row in db.scalars(select(FederatedNode).where(FederatedNode.institution_id==institution)).all():
            node,values=_node(db,row.id);nodes.append(_node_public(node,values,db))
            for link in db.scalars(select(FederatedProjectNode).where(FederatedProjectNode.node_id==node.id)).all():
                body=_object(db,link)
                if body['status']!='pending':continue
                p,pc,pv=_project(db,link.project_id)
                invitations.append({'id':link.id,'project_id':p.id,'project_name':pv['name'],'purpose':pv['purpose'],
                    'project_institution_id':p.institution_id,'node_id':node.id,'node_name':values['name'],'revision':link.version})
    return {'projects':projects,'nodes':nodes,'node_invitations':invitations,'reviewer_institutions':sorted(reviewers),'real_data_enabled':False}


def audit(db,user,project_id):
    row,_,_=_scope(db,user,project_id);head,state,events=_head(db,row.institution_id)
    return {'project_id':project_id,'integrity':'verified','anchor_revision':head.revision,'events':[
        {'id':event.id,'sequence':event.sequence,'operation':body['operation'],'client_request_id':event.client_request_id,
         'actor_user_id':event.actor_user_id,'created_at':event.created_at.isoformat()}
        for event,body in events if event.project_id==project_id]}


def assert_project_gate(db,project_id,user_id=None,permission='view'):
    """Called by the unified consent/access service; legacy W02 projects stay W02."""
    core=db.get(ResearchProject,project_id) if project_id else None
    federated=bool(core and core.ledger_key.startswith('fed-project-'))
    if 'federated_projects' not in inspect(db.connection()).get_table_names():
        if federated:raise HTTPException(503,'原联邦项目扩展结构缺失，不能降级为旧项目授权。')
        return
    row=db.get(FederatedProject,project_id) if project_id else None
    if row is None:
        if federated:raise HTTPException(503,'原联邦项目的认证资料缺失，不能降级授权。')
        return
    row,_,_=_project(db,project_id,active=True)
    if user_id is not None:
        user=db.get(User,user_id,populate_existing=True)
        if user is None or not user.is_active:raise HTTPException(403,'研究成员账号已失效。')
        _member(db,user,row,permission)


def _bound_project(db,project_id,original):
    current=db.get(ResearchProject,project_id,populate_existing=True)
    if not original or current is None or current.id!=original.get('id') or current.ledger_key!=original.get('ledger_key') or current.revision!=original.get('revision'):
        raise HTTPException(403,'原授权对应的项目审批版本已经改变，需要分别重新确认。')
    _verify_core(current,original)


def _grant_material(row):
    result={key:getattr(row,key) for key in ('patient_id','project_id','scope','purpose','grantor_user_id','actor_identity_basis','terms_version','authority_id','ledger_key')}
    result['expires_at']=_utc(row.expires_at).isoformat() if row.expires_at else None
    return result


def bind_research_consent(db,row):
    if row.purpose!='research':return
    core=db.get(ResearchProject,row.project_id,populate_existing=True)
    if core is None or not core.ledger_key.startswith('fed-project-'):return
    project,core,values=_project(db,row.project_id,active=True)
    binding=FederatedConsentBinding(id=row.id,project_id=row.project_id,institution_id=project.institution_id,version=1,sealed_payload='')
    binding.put({'project_authority':_core(core),'original_approval_credentials':values['approval_credentials'],'grant_material':_grant_material(row)})
    db.add(binding)


def assert_consent_gate(db,row):
    core=db.get(ResearchProject,row.project_id,populate_existing=True)
    if core is None or not core.ledger_key.startswith('fed-project-'):return
    binding=db.get(FederatedConsentBinding,row.id,populate_existing=True)
    if binding is None:raise HTTPException(403,'原具体研究同意缺少项目审批版本依据，需要重新核对。')
    values=binding.read()
    if binding.project_id!=row.project_id or values['grant_material']!=_grant_material(row):
        raise RecordIntegrityError('Unified consent material differs from its original institution-bound grant.')
    _bound_project(db,row.project_id,values['project_authority']);_original_credentials(db,values['original_approval_credentials'])


def own_consent_context(db,user,project_id,patient_id):
    identity_basis(db,user.id,patient_id)
    row,core,values=_project(db,project_id)
    from backend.app.models.consent import ConsentRecord
    from backend.app.services.consent_service import consent_response
    records=db.scalars(select(ConsentRecord).where(ConsentRecord.patient_id==patient_id,ConsentRecord.purpose=='research',ConsentRecord.project_id==project_id).order_by(ConsentRecord.id)).all()
    return {'project':_project_public(row,core,values),'patient_id':patient_id,'items':[consent_response(db,r) for r in records],
        'notice':'只授权此项目和所选资料范围。撤回阻止后续处理；不会声称删除已发布模型中的全部影响。首期项目只运行合成数据。'}


def consent_action(db,user,project_id,payload,*,withdraw=False):
    from backend.app.models.consent import ConsentRecord
    from backend.app.services.consent_service import prepare_grant,prepare_withdraw
    operation='consent_withdraw' if withdraw else 'consent_grant';request=_body(payload)
    old=_old(db,user,payload.client_request_id,operation,project_id,request)
    if old:return old
    basis=identity_basis(db,user.id,payload.patient_id)
    project,pc,pv=_project(db,project_id)
    head,state,_=_head(db,project.institution_id,lock=True)
    if withdraw:
        # Denial remains available even after a project expires or its DAC loses
        # qualifications. The original patient's own identity is still required.
        row=db.get(ConsentRecord,payload.consent_id,populate_existing=True)
        if row is None or row.patient_id!=payload.patient_id or row.project_id!=project_id or row.purpose!='research':
            raise HTTPException(404,'本人此项目的原授权不存在。')
        if row.revision!=payload.expected_revision or row.status!='active':raise HTTPException(409,'原授权版本已经变化。')
        prepare_withdraw(db,row,user.id,basis);activate=()
    else:
        if payload.project_id!=project_id:raise HTTPException(422,'授权必须对应当前具体研究项目。')
        project,pc,pv=_project(db,project_id,active=True);record_authority(db,pc)
        if payload.expected_project_revision!=pc.revision:raise HTTPException(409,'所读项目审批版本已经变化，旧授权原件不能借用新版本。')
        if payload.expires_at is not None and payload.expires_at.tzinfo is None:raise HTTPException(422,'授权有效期需要含时区。')
        row=prepare_grant(db,patient_id=payload.patient_id,actor_id=user.id,purpose='research',scope=payload.scope,
            project_id=project_id,target_user_id=payload.target_user_id,expires_at=_utc(payload.expires_at) if payload.expires_at else None,
            expected_project_revision=payload.expected_project_revision)
        activate=(row,)
    result={key:getattr(row,key) for key in ('id','patient_id','project_id','purpose','scope','status','revision','grantor_user_id','actor_identity_basis','terms_version')}
    result['expires_at']=row.expires_at.isoformat() if row.expires_at else None
    if not withdraw:result['project_revision']=pc.revision
    receipt=FederatedConsentReceipt(id=uuid4().hex,institution_id=project.institution_id,version=1,sealed_payload='',
        project_id=project_id,patient_id=row.patient_id,consent_id=row.id)
    receipt.put({'project_id':project_id,'patient_id':row.patient_id,'consent_id':row.id,'original_request':request,
        'actor_user_id':user.id,'actor_identity_basis':basis,'operation':operation,
        'notice':'This is an immutable operation receipt, not a second current-consent fact.'})
    db.add(receipt)
    return _append(db,user,head,state,receipt,operation,project_id,request,result,project_id,activate)
