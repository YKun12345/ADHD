"""A human disposition is separate from the business operation it may prefill."""
from datetime import datetime,timezone
from sqlalchemy import select,update
from fastapi import HTTPException
from backend.app.models.agent import AIArtifact,ArtifactDecision,metadata
from backend.app.schemas.agent import ArtifactDecisionCreate
from backend.app.services.agent import runner
from backend.app.services.agent.tools import _process
from backend.app.services.agent.provider_authority import check_external
from backend.app.services import review_service as reviews,care_plan_service as plans,assessment_service as assessments
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.attention_action_service import _original

PROFESSIONAL_KINDS={'review_questions','plan_draft','reply_draft','assessment_summary'}
TARGETS={'review_questions':'review_question','plan_draft':'plan_publication','reply_draft':'shared_message','assessment_summary':'review_draft',
    'profile_fields':'assessment_background','cycle_summary':'cycle_review'}


def _artifact(db,user,identifier,*,processing=False):
    ref=db.execute(select(AIArtifact.run_id,AIArtifact.actor_user_id,AIArtifact.patient_id).where(AIArtifact.id==identifier)).first()
    if ref is None: raise HTTPException(404,'Agent artifact not found.')
    if ref.actor_user_id!=user.id: raise HTTPException(403,'This private draft belongs to another actual actor.')
    run,frame=runner._owned(db,user,ref.run_id)
    artifact=db.get(AIArtifact,identifier,populate_existing=True)
    if run.status!='completed' or run.artifact_id!=artifact.id or artifact.input_digest!=run.input_digest:
        raise HTTPException(503,'The private artifact and its completed run disagree.')
    if processing:
        _process(db,user,ref.patient_id); runner._authority(db,run.snapshot['authority'])
        if run.snapshot['authority'].get('external_ai') is not None:
            check_external(db,ref.patient_id,frame,run.snapshot['authority']['external_ai'])
        if frame['input_digest']!=artifact.input_digest: raise HTTPException(409,'The draft input changed; prepare and review a new draft.')
    return artifact,run,frame


def _latest(db,artifact_id,*,locked=False):
    query=select(ArtifactDecision.version).where(ArtifactDecision.artifact_id==artifact_id).order_by(ArtifactDecision.version.desc()).limit(1)
    # A locking read sees the committed head after the artifact write lock,
    # including on MySQL's repeatable-read isolation level.
    if locked: query=query.with_for_update()
    return db.scalar(query) or 0


def _baseline(artifact,content):
    body=artifact.snapshot['body']
    if artifact.kind=='review_questions':
        candidates=[{key:row[key] for key in ('source_type','source_key','question')} for row in body.get('questions',[])]
        return next((row for row in candidates if isinstance(content,dict) and (row['source_type'],row['source_key'])==(content.get('source_type'),content.get('source_key'))),candidates[0] if candidates else None)
    if artifact.kind=='plan_draft':
        value=body.get('plan_draft') or {}
        return {key:value[key] for key in ('title','instructions','source_report_id')} if value else None
    if artifact.kind=='reply_draft': return {'text':body['reply_draft']['text']}
    if artifact.kind=='assessment_summary': return {'text':body['reply']}
    if artifact.kind=='cycle_summary':
        value=body.get('cycle_draft') or {}
        return {'text':value['text']} if value.get('cycle_id') and value.get('text') else None
    if artifact.kind=='profile_fields':
        fields=(body.get('profile_draft') or {}).get('fields') or {}
        return {'fields':{key:{'status':field['status'],'value':field['value']} for key,field in fields.items()}} if fields else None
    return None


def _content(artifact,decision,content,confirmed_fields=None):
    if decision=='reject':
        if content is not None: raise HTTPException(422,'A rejection does not supply adoptable business content.')
        return None,None
    baseline=_baseline(artifact,content)
    if baseline is None or not isinstance(content,dict) or set(content)!=set(baseline):
        raise HTTPException(422,'This artifact has no supported, specifically selected editable fields.')
    if artifact.kind=='review_questions' and any(content[key]!=baseline[key] for key in ('source_type','source_key')):
        raise HTTPException(409,'A human question cannot be rebound to an invented draft source.')
    if artifact.kind=='plan_draft' and content['source_report_id']!=baseline['source_report_id']:
        raise HTTPException(409,'A plan draft must retain its actual published opinion source.')
    if artifact.kind=='profile_fields':
        fields=content.get('fields')
        if not isinstance(fields,dict) or set(fields)!=set(baseline['fields']) or not isinstance(confirmed_fields,list) or len(confirmed_fields)!=len(fields) or set(confirmed_fields)!=set(fields):
            raise HTTPException(422,'Confirm every selected actual background field separately before adoption.')
        for field in fields.values():
            if not isinstance(field,dict) or set(field)!={'status','value'} or field['status'] not in {'provided','unknown','skipped'}:
                raise HTTPException(422,'Keep each actual background field status and value.')
            if field['status']=='provided':
                if not isinstance(field['value'],str) or not field['value'].strip() or len(field['value'])>1000:
                    raise HTTPException(422,'Provided background needs actual text within its business limit.')
            elif field['value'] is not None:
                raise HTTPException(422,'Unknown and skipped background must remain null.')
    elif confirmed_fields:
        raise HTTPException(422,'Field confirmations apply only to actual background fields.')
    for key,limit in [('question',2000),('title',120),('instructions',4000),('text',8000 if artifact.kind in {'assessment_summary','cycle_summary'} else 2000)]:
        if key in content and (not isinstance(content[key],str) or not content[key].strip() or len(content[key])>limit):
            raise HTTPException(422,'The human-edited field is empty or exceeds its actual business limit.')
    equal=canonical_digest(content)==canonical_digest(baseline)
    if decision=='adopt' and not equal or decision=='edit' and equal:
        raise HTTPException(409,'Record adopt for unchanged fields, or edit for actual human changes.')
    return TARGETS[artifact.kind],content


def _basis(db,user,run,*,professional=False):
    from backend.app.services.identity_access import self_access,identity_basis,require_doctor
    if self_access(db,user.id,run.patient_id):
        if professional: raise HTTPException(403,'Professional drafts require the actual responsible doctor.')
        return identity_basis(db,user.id,run.patient_id)
    qualification=require_doctor(db,user.id)
    aid=run.snapshot['request'].get('assessment_id')
    if professional:
        if aid is None: raise HTTPException(422,'Select the actual assessment before adopting this professional draft.')
        session=reviews._assessment(db,aid); reviews._doctor_authority(db,user,session)
        return reviews._doctor_basis(db,user,session)
    return f'doctor:{user.id}:qualification:{qualification.id}:revision:{qualification.revision}'


def _adoption_basis(db,user,artifact,run):
    if artifact.kind=='profile_fields':
        from backend.app.services.identity_access import self_access,require_processing_access
        if not self_access(db,user.id,run.patient_id):
            raise HTTPException(403,'Only the actual self user or verified guardian can confirm provided background fields.')
        require_processing_access(db,user,run.patient_id,{'assessment','profile'})
        return _basis(db,user,run)
    if artifact.kind=='cycle_summary':
        from backend.app.services import cycle_review_service,care_cycle_service
        identifier=run.snapshot['request'].get('cycle_id')
        if not identifier: raise HTTPException(422,'Select one actual cycle before adopting its summary.')
        cycle=care_cycle_service._load_cycle(db,identifier)
        if cycle.patient_id!=run.patient_id: raise HTTPException(409,'The cycle summary belongs to another profile.')
        plan=cycle_review_service._access(db,user,cycle,processing=True)
        if plan is not None:
            return reviews._doctor_basis(db,user,reviews._assessment(db,plan.assessment_id))
        return _basis(db,user,run)
    if artifact.kind in PROFESSIONAL_KINDS:
        return _basis(db,user,run,professional=True)
    raise HTTPException(403,'This ordinary answer has no adoptable business content.')


@reviews.storage_boundary
def decision_context(db,user,artifact_id):
    artifact,run,frame=_artifact(db,user,artifact_id,processing=True)
    professional=artifact.kind in PROFESSIONAL_KINDS and frame['role']=='researcher' and run.snapshot['request'].get('assessment_id') is not None
    basis=_basis(db,user,run,professional=professional)
    baseline=_baseline(artifact,None)
    adoptable=False
    if baseline and artifact.kind in TARGETS:
        try:
            _adoption_basis(db,user,artifact,run); adoptable=True
        except HTTPException as exc:
            if exc.status_code not in {403,409,422}: raise
    ctx={'purpose':'artifact_decision','context_version':1,'artifact_id':artifact.id,'run_id':run.id,'patient_id':artifact.patient_id,
        'actor_user_id':user.id,'actor_identity_basis':basis,'input_digest':artifact.input_digest,'artifact_body_digest':artifact.body_digest,
        'artifact_source_digest':artifact.source_digest,'expected_previous_version':_latest(db,artifact.id),
        'authorization_snapshot':assessments.authorization_snapshot(db),'credential_snapshot':plans._credentials(db)}
    ctx['artifact_kind']=artifact.kind
    reviews._audit(db,user,artifact.patient_id,'data_read',{'scope':'artifact_decision_preflight','artifact_id':artifact.id})
    return {**ctx,'decision_context':reviews._encode(ctx,'artifact-decision-context'),'decision_context_digest':canonical_digest(ctx),
        'kind':artifact.kind,'assessment_id':run.snapshot['request'].get('assessment_id'),'cycle_id':run.snapshot['request'].get('cycle_id'),'default_content':baseline,
        'allowed_decisions':['adopt','edit','reject'] if adoptable else ['reject']}


def _ack(row): return {'id':row.id,**row.snapshot['ack'],'submission_status':'committed','legacy':False}


@reviews.storage_boundary
def decide(db,user,payload):
    payload=reviews._validate(ArtifactDecisionCreate,payload); values=payload.model_dump()
    if values['confirmed_fields'] is None: values.pop('confirmed_fields')
    if not payload.confirmed or not payload.reason.strip(): raise HTTPException(422,'The actual human must explicitly confirm a reason.')
    artifact,run,frame=_artifact(db,user,payload.artifact_id,processing=True)
    if artifact.patient_id!=payload.patient_id: raise HTTPException(409,'The actual artifact belongs to another profile.')
    ctx=reviews._decode(payload.decision_context,'artifact-decision-context')
    expected={'purpose':'artifact_decision','context_version':1,'artifact_id':artifact.id,'run_id':run.id,'patient_id':artifact.patient_id,
        'actor_user_id':user.id,'input_digest':artifact.input_digest,'artifact_body_digest':artifact.body_digest,
        'artifact_source_digest':artifact.source_digest,'expected_previous_version':payload.expected_previous_version}
    if any(ctx.get(key)!=value for key,value in expected.items()): raise HTTPException(409,'The disposition differs from its original actual draft preflight.')
    _original(db,ctx['authorization_snapshot']); plans._original_credentials(db,ctx['credential_snapshot'])
    previous=db.scalar(select(ArtifactDecision).where(ArtifactDecision.client_decision_id==payload.client_decision_id))
    if previous:
        if previous.actor_user_id!=user.id or previous.payload_digest!=canonical_digest(values): raise HTTPException(409,'This human decision ID belongs to different immutable content.')
        reviews._audit(db,user,artifact.patient_id,'artifact_decision_retry_ack',{'decision_id':previous.id}); return _ack(previous),False
    db.execute(update(AIArtifact).where(AIArtifact.id==artifact.id).values(id=AIArtifact.id))
    if _latest(db,artifact.id,locked=True)!=payload.expected_previous_version: raise HTTPException(409,'Another human disposition changed this artifact; reread it first.')
    target,content=_content(artifact,payload.decision,payload.content,payload.confirmed_fields)
    if target is not None: _adoption_basis(db,user,artifact,run)
    professional=artifact.kind in PROFESSIONAL_KINDS and frame['role']=='researcher' and run.snapshot['request'].get('assessment_id') is not None
    basis=_basis(db,user,run,professional=professional)
    if basis!=ctx['actor_identity_basis']: raise HTTPException(409,'The actual human identity basis changed.')
    row=ArtifactDecision(artifact_id=artifact.id,patient_id=artifact.patient_id,actor_user_id=user.id,client_decision_id=payload.client_decision_id,
        version=payload.expected_previous_version+1,decision=payload.decision,target_type=target,
        target_client_id='ai-use-'+canonical_digest(payload.client_decision_id)[:40] if target else None,
        input_digest=artifact.input_digest,payload_digest=canonical_digest(values),created_at=datetime.now(timezone.utc).replace(microsecond=0))
    ack={key:values[key] for key in ('client_decision_id','patient_id','artifact_id','expected_previous_version','decision','reason','confirmed')}
    ack.update(actor_user_id=user.id,actor_identity_basis=basis,version=row.version,content=content,target_type=target,target_client_id=row.target_client_id,
        input_digest=row.input_digest,payload_digest=row.payload_digest,decision_context_digest=canonical_digest(ctx),
        authorization_snapshot=ctx['authorization_snapshot'],created_at=reviews._utc(row.created_at),original_request=values)
    if payload.confirmed_fields is not None: ack['confirmed_fields']=payload.confirmed_fields
    row.snapshot={'metadata':metadata(row),'payload':values,'ack':ack,'authorization_snapshot':ctx['authorization_snapshot'],'credential_snapshot':ctx['credential_snapshot']}
    db.add(row); db.flush(); reviews._audit(db,user,artifact.patient_id,'agent_artifact_decision',{'artifact_id':artifact.id,'decision_id':row.id,'decision':row.decision})
    return _ack(row),True


@reviews.storage_boundary
def query_original(db,user,client_id):
    ref=db.execute(select(ArtifactDecision.id,ArtifactDecision.artifact_id,ArtifactDecision.actor_user_id).where(ArtifactDecision.client_decision_id==client_id)).first()
    if ref is None: raise HTTPException(404,'The original human disposition has not been committed.')
    if ref.actor_user_id!=user.id: raise HTTPException(403,'This human disposition belongs to another actual actor.')
    artifact,_,_=_artifact(db,user,ref.artifact_id)
    row=db.get(ArtifactDecision,ref.id); reviews._audit(db,user,artifact.patient_id,'data_read',{'scope':'artifact_decision_original','decision_id':row.id})
    return _ack(row)


@reviews.storage_boundary
def history(db,user,artifact_id):
    artifact,_,_=_artifact(db,user,artifact_id)
    items=[_ack(row) for row in db.scalars(select(ArtifactDecision).where(ArtifactDecision.artifact_id==artifact.id).order_by(ArtifactDecision.version.desc())).all()]
    reviews._audit(db,user,artifact.patient_id,'data_read',{'scope':'artifact_human_history','artifact_id':artifact.id})
    return {'artifact_id':artifact.id,'patient_id':artifact.patient_id,'actor_user_id':user.id,'items':items}


@reviews.storage_boundary
def adoption_context(db,user,identifier,*,for_business=False):
    ref=db.execute(select(ArtifactDecision.artifact_id,ArtifactDecision.actor_user_id).where(ArtifactDecision.id==identifier)).first()
    if ref is None: raise HTTPException(404,'Human disposition not found.')
    if ref.actor_user_id!=user.id: raise HTTPException(403,'The editable draft belongs to another actual actor.')
    artifact,run,frame=_artifact(db,user,ref.artifact_id,processing=True)
    if for_business:
        # Follow decide's audit-head -> artifact lock order. Hold this same
        # artifact lock through the caller's actual business commit.
        db.execute(update(AIArtifact).where(AIArtifact.id==artifact.id).values(id=AIArtifact.id))
    row=db.get(ArtifactDecision,identifier,populate_existing=True)
    if row.decision=='reject' or row.version!=_latest(db,artifact.id,locked=for_business): raise HTTPException(409,'This draft was rejected or replaced by a later human disposition.')
    _original(db,row.snapshot['authorization_snapshot']); plans._original_credentials(db,row.snapshot['credential_snapshot'])
    _adoption_basis(db,user,artifact,run)
    reviews._audit(db,user,row.patient_id,'data_read',{'scope':'artifact_adoption_preflight','decision_id':row.id})
    return {**_ack(row),'assessment_id':run.snapshot['request'].get('assessment_id'),'cycle_id':run.snapshot['request'].get('cycle_id'),
        'requires_separate_business_confirmation':True}


def validate_adoption(db,user,identifier,*,target_type,client_id,patient_id,assessment_id=None,cycle_id=None,content):
    value=adoption_context(db,user,identifier,for_business=True)
    if value['target_type']!=target_type or value['target_client_id']!=client_id or value['patient_id']!=patient_id or (
            assessment_id is not None and value['assessment_id']!=assessment_id) or (cycle_id is not None and value['cycle_id']!=cycle_id) or canonical_digest(value['content'])!=canonical_digest(content):
        raise HTTPException(409,'The business operation differs from the actual human-edited draft and its unique target ID.')
    return value
