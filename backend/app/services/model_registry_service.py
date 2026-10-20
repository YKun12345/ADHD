"""Version registration does not grant provenance, input equivalence or activation."""
from datetime import datetime,timezone
from pathlib import Path
import hashlib,hmac,json
from fastapi import HTTPException
from sqlalchemy import select,update,inspect
from backend.app.models.model_registry import ModelRegistry,ModelVersion,ModelRegistryAction,tag,verify
from backend.app.schemas.model_registry import CandidateCreate,RegistryAction
from backend.app.services.identity_access import require_reviewer,active_memberships,record_authenticated_actor,recheck_request_authority
from backend.app.services import authorization_ledger as ledger
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.core.config import settings


REQUIRED_REVIEW=('code_license','weight_license','training_data_permission','intended_use','input_contract')


def _schema(db):
    names=inspect(db.connection()).get_table_names()
    if any(name not in names for name in ('model_registry','model_versions','model_registry_actions')):raise HTTPException(503,'模型注册结构需经授权升级。')


def _reviewer(db,user):
    record_authenticated_actor(db,user);return require_reviewer(db,user.id)


def artifact_path(version):
    root=Path(settings.MODEL_REGISTRY_ARTIFACT_ROOT).expanduser().resolve()
    target=(root/version.manifest['artifact_file']).resolve()
    if not target.is_relative_to(root) or not target.is_file() or target==root:raise HTTPException(409,'可信模型包不在已配置的注册目录中。')
    with target.open('rb') as stream:actual=hashlib.file_digest(stream,'sha256').hexdigest()
    if actual!=version.artifact_sha256:raise HTTPException(409,'实际模型包摘要与候选版本不一致。')
    return target


def _version(db,identifier):
    _schema(db);row=db.get(ModelVersion,identifier,populate_existing=True)
    if row is None:raise HTTPException(404,'注册模型版本不存在。')
    return row


def _head(db,family):
    row=db.get(ModelRegistry,family,populate_existing=True)
    if row is None:raise HTTPException(404,'模型族尚未注册。')
    verify(row)
    if not ledger.matches(row):raise HTTPException(503,'模型指针与独立单调账本不一致，禁止借用旧版本。')
    history='';last=None
    for action in db.scalars(select(ModelRegistryAction).where(ModelRegistryAction.family==family).order_by(ModelRegistryAction.id)).all():
        history=canonical_digest({'previous':history,'action_id':action.id,'payload':action.payload,'actor_user_id':action.actor_user_id});last=action.id
    if history!=row.history_digest or last!=row.latest_action_id:raise HTTPException(503,'模型审查或版本历史与独立指针锚点不一致。')
    return row


def _audit(db,user,action,detail):
    from backend.app.services.security_service import _append_audit_log
    _append_audit_log(db,action=action,status='success',message='模型注册、来源审查与唯一版本指针操作。',actor_user_id=user.id,detail_json=detail)


def _public(row):
    return {'id':row.id,'family':row.family,'version':row.version,'artifact_sha256':row.artifact_sha256,'manifest':row.manifest,'registered_by':row.actor_user_id,'created_at':row.created_at.isoformat()}


def register(db,user,payload):
    membership=_reviewer(db,user);_schema(db);payload=CandidateCreate.model_validate(payload)
    manifest=payload.model_dump();manifest['institution_id']=membership.institution_id
    old=db.scalar(select(ModelVersion).where(ModelVersion.family==payload.family,ModelVersion.version==payload.version))
    if old:
        if old.manifest!=manifest:raise HTTPException(409,'该模型版本已有不同的不可变来源资料。')
        return _public(old)
    row=ModelVersion(family=payload.family,version=payload.version,artifact_sha256=payload.artifact_sha256,actor_user_id=user.id,manifest=manifest);row.state_tag=tag(row)
    artifact_path(row);db.add(row);db.flush()
    head=db.get(ModelRegistry,payload.family)
    if head is None:
        head=ModelRegistry(family=payload.family,active_version_id=None,revision=1,ledger_key='model-'+hashlib.sha256(payload.family.encode()).hexdigest()[:48],latest_action_id=None,history_digest='');head.state_tag=tag(head)
        ledger.reserve(head);db.add(head);db.flush()
        _audit(db,user,'model_family_created',{'family':head.family});recheck_request_authority(db);db.commit();ledger.publish(head)
    _audit(db,user,'model_candidate_registered',{'version_id':row.id,'artifact_sha256':row.artifact_sha256});return _public(row)


def listing(db,user,family='hgst'):
    _reviewer(db,user);_schema(db)
    rows=db.scalars(select(ModelVersion).where(ModelVersion.family==family).order_by(ModelVersion.id.desc())).all()
    pointer=None
    if rows:
        head=_head(db,family);pointer={'family':head.family,'active_version_id':head.active_version_id,'revision':head.revision}
    actions=db.scalars(select(ModelRegistryAction).where(ModelRegistryAction.family==family).order_by(ModelRegistryAction.id.desc())).all()
    return {'family':family,'pointer':pointer,'versions':[_public(row) for row in rows],
        'actions':[{'id':row.id,'version_id':row.version_id,'action':row.action,'actor_user_id':row.actor_user_id,'client_action_id':row.client_action_id,'payload':row.payload} for row in actions]}


def _proof(version,evidence,*,require_recent=True):
    try:keys=json.loads(settings.MODEL_REGISTRY_INSTANCE_KEYS_JSON)
    except (ValueError,TypeError):raise HTTPException(503,'推理实例身份密钥未配置。')
    instance=evidence.get('instance_id');secret=keys.get(instance)
    if not isinstance(secret,str) or len(secret)<32:raise HTTPException(403,'实际推理实例不在可信清单中。')
    body={key:value for key,value in evidence.items() if key!='signature'}
    expected=hmac.new(secret.encode(),canonical_digest(body).encode(),hashlib.sha256).hexdigest()
    if not isinstance(evidence.get('signature'),str) or not hmac.compare_digest(evidence['signature'],expected):raise HTTPException(403,'实例加载证明签名无效。')
    try:at=datetime.fromisoformat(body['loaded_at'].replace('Z','+00:00'))
    except (KeyError,ValueError,TypeError):raise HTTPException(422,'加载证明时间不完整。')
    if at.tzinfo is None:raise HTTPException(409,'实例加载证明时间缺少时区。')
    age=(datetime.now(timezone.utc)-at).total_seconds()
    if age < -60 or require_recent and age>900:raise HTTPException(409,'实例加载证明已过期或时间不可信。')
    if body.get('version_id')!=version.id or body.get('artifact_sha256')!=version.artifact_sha256 or body.get('input_contract_digest')!=version.manifest['input_contract_digest'] or body.get('loaded') is not True or body.get('numeric_equivalence_verified') is not True:
        raise HTTPException(409,'实例没有证明这个实际模型包和数值输入契约可用。')
    return instance


def _eligible(db,version,*,fresh_proofs=True):
    actions=db.scalars(select(ModelRegistryAction).where(ModelRegistryAction.version_id==version.id).order_by(ModelRegistryAction.id.desc())).all()
    review=next((a for a in actions if a.action=='review'),None)
    if review is None:raise HTTPException(409,'代码、权重、数据、用途和输入契约尚未分别审查。')
    reviewer=db.get(__import__('backend.app.models.user',fromlist=['User']).User,review.actor_user_id)
    if reviewer is None or not reviewer.is_active:raise HTTPException(403,'原模型审核账号已失效。')
    membership=require_reviewer(db,reviewer.id,version.manifest['institution_id'])
    from backend.app.services.care_plan_service import _original_credentials
    _original_credentials(db,review.authority_snapshot)
    checks=review.payload['evidence']
    if any(not isinstance(checks.get(key),dict) or checks[key].get('status')!='verified' or not checks[key].get('reference') for key in REQUIRED_REVIEW):raise HTTPException(409,'存在未核验或被拒绝的来源/用途条件。')
    required=[v.strip() for v in settings.MODEL_REGISTRY_REQUIRED_INSTANCES.split(',') if v.strip()]
    if not required:raise HTTPException(503,'尚未明确全部生产推理实例，不能切换指针。')
    proofs=set()
    for action in actions:
        if action.action=='load_proof':
            try:
                _original_credentials(db,action.authority_snapshot)
                proofs.add(_proof(version,action.payload['evidence'],require_recent=fresh_proofs))
            except HTTPException:continue
    if not set(required).issubset(proofs):raise HTTPException(409,'所有推理实例尚未提供当前有效、签名的实际加载和输入等价证明。')
    artifact_path(version);return actions


def action(db,user,payload):
    membership=_reviewer(db,user);payload=RegistryAction.model_validate(payload)
    if not payload.confirmed or not payload.reason.strip():raise HTTPException(422,'需要实际审核人明确确认与理由。')
    version=_version(db,payload.version_id)
    if membership.institution_id!=version.manifest['institution_id']:raise HTTPException(403,'需要候选模型原负责机构的审核权限。')
    values=payload.model_dump();old=db.scalar(select(ModelRegistryAction).where(ModelRegistryAction.client_action_id==payload.client_action_id))
    if old:
        if old.actor_user_id!=user.id or old.payload!=values:raise HTTPException(409,'原操作编号已有不同不可变内容。')
        return {'id':old.id,'action':old.action,'version_id':old.version_id,'original_request':old.payload,'submission_status':'committed'}
    db.execute(update(ModelRegistry).where(ModelRegistry.family==version.family).values(revision=ModelRegistry.revision))
    head=_head(db,version.family)
    if head.revision!=payload.expected_registry_revision:raise HTTPException(409,'唯一模型版本指针已变化，请重新读取。')
    if payload.action=='review':
        if set(payload.evidence)!=set(REQUIRED_REVIEW) or any(not isinstance(v,dict) or v.get('status') not in {'verified','unverified','denied'} or not isinstance(v.get('reference'),str) or not v['reference'].strip() for v in payload.evidence.values()):raise HTTPException(422,'请分别记录五项来源/用途审查状态与实际证据引用。')
    elif payload.action=='load_proof':_proof(version,payload.evidence)
    else:
        if version.manifest['purpose']!='screening_support':raise HTTPException(409,'研究专用候选不能激活为用户推理。')
        _eligible(db,version)
        if payload.action=='rollback' and not db.scalar(select(ModelRegistryAction.id).where(ModelRegistryAction.version_id==version.id,ModelRegistryAction.action.in_(['activate','rollback']))):raise HTTPException(409,'回滚目标不是曾实际激活的版本。')
        head.active_version_id=version.id
    from backend.app.services.care_plan_service import _credentials
    row=ModelRegistryAction(family=version.family,version_id=version.id,actor_user_id=user.id,client_action_id=payload.client_action_id,action=payload.action,payload=values,authority_snapshot=_credentials(db));row.state_tag=tag(row);db.add(row);db.flush()
    ledger.deny(head)
    head.history_digest=canonical_digest({'previous':head.history_digest,'action_id':row.id,'payload':values,'actor_user_id':user.id});head.latest_action_id=row.id;head.state_tag=tag(head)
    _audit(db,user,'model_registry_'+payload.action,{'version_id':version.id,'registry_revision':head.revision,'action_id':row.id});recheck_request_authority(db)
    # Each review/proof also advances the independent history anchor: a restored
    # old approval must not become usable by deleting a later denial.
    db.commit();ledger.publish(head)
    return {'id':row.id,'action':row.action,'version_id':version.id,'registry_revision':head.revision,'original_request':values,'submission_status':'committed'}


def active(db,family='hgst'):
    _schema(db);head=_head(db,family)
    if head.active_version_id is None:raise HTTPException(409,'尚无经过准入的激活模型。')
    # Fresh instance loading is required before every activation/rollback.
    # Active use keeps checking signed original proof, original credentials,
    # current history/ledger and exact package bytes; it is not a 15-minute lease.
    version=_version(db,head.active_version_id);_eligible(db,version,fresh_proofs=False)
    return version,artifact_path(version),head.revision
