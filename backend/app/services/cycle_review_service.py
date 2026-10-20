"""Human stage decisions freeze real records and create actual follow-up objects."""
from datetime import datetime, timezone
from sqlalchemy import select, update, func
from fastapi import HTTPException
from backend.app.models.review import CycleReview, metadata
from backend.app.models.care_cycle import CareCycle
from backend.app.models.patient import Patient
from backend.app.models.care_plan import state
from backend.app.schemas.cycle_review import CycleReviewCreate
from backend.app.schemas.care_plan import PlanPublication
from backend.app.schemas.care_cycle import CareCycleCreate
from backend.app.schemas.assessment import AssessmentCreateRequest
from backend.app.services import review_service as reviews, care_plan_service as plans, care_cycle_service as cycles, assessment_service as assessments
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.attention_action_service import _original, _historical_original
from backend.app.services.identity_access import self_access, identity_basis


def _latest(db, cycle_id):
    return db.scalar(select(func.max(CycleReview.version)).where(CycleReview.cycle_id == cycle_id)) or 0


def _access(db, user, cycle, *, processing=False):
    cycles._cycle_access(db, user, cycle)
    if not processing:
        return None
    if cycle.cycle_type == 'professional':
        if user.id != cycle.responsible_doctor_id:
            raise HTTPException(403, 'Only the original responsible doctor may confirm a professional cycle review.')
        plan, version = plans.authorize_cycle(db, user, cycle)
        plans._processing(db, user, plan)
        if plan.current_plan_version_id != version.id:
            raise HTTPException(409, 'Review the actual current plan cycle; this future schedule has been superseded.')
        return plan
    cycles._own(db, user, cycle.patient_id, processing=True)
    if cycle.actor_user_id != user.id:
        raise HTTPException(403, 'Only the actual original user or guardian can close this self cycle.')
    _original(db, cycle.authorization_snapshot)
    return None


def _inputs(db, user, cycle):
    value = cycles.get_cycle(db, user, cycle.id)
    return {'cycle': value, 'record_revisions':[cycles._ack(row) for row in cycles._cycle_records(db,cycle)],
        'plan': plans.get_plan(db, user, plans.authorize_cycle(db, user, cycle)[0].id)
        if cycle.cycle_type == 'professional' else None, 'calendar_today': plans.today().isoformat(),
        'interpretation': '实际日期与记录覆盖；缺失不归零，不是治疗效果。'}


@reviews.storage_boundary
def review_context(db, user, cycle_id):
    cycle = cycles._load_cycle(db, cycle_id); plan = _access(db, user, cycle, processing=True)
    from backend.app.db.review_migration import require_review_schema
    require_review_schema(db.connection())
    if cycle.start_date > plans.today():
        raise HTTPException(409, 'A future cycle has no actual stage observations to review yet.')
    if _latest(db, cycle_id):
        raise HTTPException(409, 'This cycle already has an immutable stage decision; open its actual follow-up cycle.')
    inputs = _inputs(db, user, cycle)
    if plan is None:
        basis = identity_basis(db, user.id, cycle.patient_id); next_plan = None
    else:
        basis = reviews._doctor_basis(db, user, reviews._assessment(db, plan.assessment_id))
        next_plan = plans.plan_context(db, user, plan.assessment_id)
    ctx = {'purpose': 'cycle_review', 'context_version': 1, 'cycle_id': cycle.id, 'patient_id': cycle.patient_id,
        'cycle_type': cycle.cycle_type, 'actor_user_id': user.id, 'actor_identity_basis': basis,
        'expected_previous_version': 0, 'input_digest': canonical_digest(inputs),
        'authorization_snapshot': assessments.authorization_snapshot(db), 'credential_snapshot': plans._credentials(db),
        'plan_context': next_plan}
    reviews._audit(db, user, cycle.patient_id, 'data_read', {'scope': 'cycle_review_preflight', 'cycle_id': cycle.id})
    return {**ctx, 'review_context': reviews._encode(ctx,'cycle-review-context'), 'review_context_digest': canonical_digest(ctx),
        'input_snapshot': inputs, 'allowed_decisions': ['continue','adjust','end','next_round'] if plan else ['end','next_round']}


def _ack(row):
    return {'id': row.id, **row.snapshot['ack'], 'submission_status': 'committed', 'legacy': False}


def _read(db, user, row):
    cycle = cycles._load_cycle(db, row.cycle_id); _access(db, user, cycle)
    if not self_access(db, user.id, cycle.patient_id):
        _historical_original(db, row.snapshot['authorization_snapshot'])
    return _ack(row)


@reviews.storage_boundary
def list_reviews(db, user, cycle_id):
    cycle = cycles._load_cycle(db, cycle_id); _access(db, user, cycle)
    result = [{**_read(db, user, row), 'input_snapshot':row.snapshot['input_snapshot']} for row in db.scalars(select(CycleReview).where(CycleReview.cycle_id == cycle_id).order_by(CycleReview.version.desc())).all()]
    reviews._audit(db, user, cycle.patient_id, 'data_read', {'scope': 'cycle_review_history', 'cycle_id': cycle_id})
    return {'patient_id': cycle.patient_id, 'cycle_id': cycle_id, 'items': result}


@reviews.storage_boundary
def query_original(db, user, client_id):
    ref = db.execute(select(CycleReview.id,CycleReview.cycle_id,CycleReview.actor_user_id).where(CycleReview.client_cycle_review_id == client_id)).first()
    if ref is None:
        raise HTTPException(404, 'The original stage review ID has not been committed.')
    if ref.actor_user_id != user.id:
        raise HTTPException(403, 'This original confirmation belongs to another actual actor.')
    cycle = cycles._load_cycle(db, ref.cycle_id); _access(db, user, cycle)
    result = _read(db,user,db.get(CycleReview,ref.id))
    reviews._audit(db, user, cycle.patient_id, 'data_read', {'scope': 'cycle_review_original_ack', 'cycle_id': cycle.id})
    return result


@reviews.storage_boundary
def confirm_review(db, user, cycle_id, payload):
    payload = reviews._validate(CycleReviewCreate,payload); values = payload.model_dump(mode='json')
    if payload.source_ai_decision_id is None: values.pop('source_ai_decision_id')
    cycle = cycles._load_cycle(db,cycle_id)
    if (cycle.id,cycle.patient_id) != (payload.cycle_id,payload.patient_id):
        raise HTTPException(409, 'The stage decision belongs to another actual cycle or profile.')
    _access(db,user,cycle)
    previous = db.scalar(select(CycleReview).where(CycleReview.client_cycle_review_id == payload.client_cycle_review_id))
    if previous:
        if previous.actor_user_id != user.id or previous.payload_digest != canonical_digest(values):
            raise HTTPException(409, 'This stage review ID already belongs to different confirmed content.')
        result = _read(db,user,previous)
        reviews._audit(db,user,cycle.patient_id,'cycle_review_retry_ack',{'cycle_review_id':previous.id})
        return result,False
    from backend.app.db.review_migration import require_review_schema
    require_review_schema(db.connection())
    if payload.source_ai_decision_id is not None:
        from backend.app.services.agent.artifact_decision_service import validate_adoption
        validate_adoption(db,user,payload.source_ai_decision_id,target_type='cycle_review',client_id=payload.client_cycle_review_id,
            patient_id=cycle.patient_id,cycle_id=cycle.id,content={'text':payload.body})
    db.execute(update(CareCycle).where(CareCycle.id == cycle.id).values(id=CareCycle.id))
    cycle = cycles._load_cycle(db,cycle.id); plan = _access(db,user,cycle,processing=True)
    ctx = reviews._decode(payload.review_context,'cycle-review-context')
    expected = {'purpose':'cycle_review','context_version':1,'cycle_id':cycle.id,'patient_id':cycle.patient_id,
        'actor_user_id':user.id,'cycle_type':cycle.cycle_type,'expected_previous_version':payload.expected_previous_version,'input_digest':payload.input_digest}
    if any(ctx.get(key) != value for key,value in expected.items()):
        raise HTTPException(409, 'This review differs from its actual actor, cycle or preflight.')
    _original(db,ctx['authorization_snapshot']); plans._original_credentials(db,ctx['credential_snapshot'])
    inputs = _inputs(db,user,cycle)
    if _latest(db,cycle.id) != payload.expected_previous_version or payload.expected_previous_version != 0 or canonical_digest(inputs) != payload.input_digest:
        raise HTTPException(409, 'The records, plan or stage review changed; reread and confirm actual inputs.')
    if cycle.start_date > plans.today():
        raise HTTPException(409, 'A future cycle is not available for a stage review.')
    next_cycle_id = next_plan_id = next_assessment_id = None
    if plan:
        if payload.next_cycle is not None:
            raise HTTPException(422, 'A professional decision cannot create an unapproved self-cycle substitute.')
        if payload.decision in {'continue','adjust'}:
            if payload.decision == 'continue' and payload.followup_plan.start_date <= cycle.end_date:
                raise HTTPException(422, 'Continuation starts after the actual current cycle; an earlier future change is an adjustment.')
            signed = ctx['plan_context']; fields = payload.followup_plan.model_dump(mode='json')
            result,_ = plans.publish_plan(db,user,PlanPublication(**fields,
                client_plan_version_id='stage-plan-'+canonical_digest(payload.client_cycle_review_id)[:40],patient_id=cycle.patient_id,
                assessment_id=plan.assessment_id,expected_assessment_version=signed['assessment_version'],
                **{key:signed[key] for key in ('expected_previous_version','expected_plan_revision','source_report_id','input_digest','plan_context')},confirmed=True))
            next_cycle_id,next_plan_id = result['cycle_id'],result['id']
        else:
            plan.status='ended'; plan.revision+=1; plan.state_snapshot=state(plan)
            if payload.decision == 'next_round':
                old = reviews._assessment(db,plan.assessment_id); patient=db.get(Patient,cycle.patient_id)
                # The current age-appropriate template is selected again by the
                # existing registry, rather than copying stale age applicability.
                from backend.app.services.assessment_templates import select_template
                template = select_template('child-demo' if patient.age < 18 else 'adult-demo','W03-demo-1',patient)
                next_session=assessments.create_assessment(db,user,AssessmentCreateRequest(patient_id=cycle.patient_id,
                    template_id=template['id'],template_version=template['version'],previous_assessment_id=old.id,background={}),
                    'doctor_assigned',commit=False)
                next_assessment_id=next_session.id
    else:
        if payload.decision not in {'end','next_round'}:
            raise HTTPException(403, 'A self cycle cannot publish a professional continuation or adjustment.')
        if payload.decision == 'next_round':
            if payload.next_cycle is None or payload.next_cycle.start_date <= max(cycle.end_date,plans.today()):
                raise HTTPException(422, 'Choose actual future dates after the original self cycle for the next independent cycle.')
            result=cycles.create_cycle(db,user,CareCycleCreate(patient_id=cycle.patient_id,
                client_cycle_id='stage-self-'+canonical_digest(payload.client_cycle_review_id)[:40],**payload.next_cycle.model_dump()))
            next_cycle_id=result['id']
        elif payload.next_cycle is not None:
            raise HTTPException(422, 'An end decision does not create another cycle.')
    now=datetime.now(timezone.utc).replace(microsecond=0)
    row=CycleReview(patient_id=cycle.patient_id,cycle_id=cycle.id,actor_user_id=user.id,client_cycle_review_id=payload.client_cycle_review_id,
        version=1,decision=payload.decision,input_digest=payload.input_digest,payload_digest=canonical_digest(values),
        next_cycle_id=next_cycle_id,next_plan_version_id=next_plan_id,next_assessment_id=next_assessment_id,created_at=now)
    ack={'client_cycle_review_id':payload.client_cycle_review_id,'patient_id':cycle.patient_id,'cycle_id':cycle.id,'actor_user_id':user.id,
        'actor_identity_basis':ctx['actor_identity_basis'],'cycle_type':cycle.cycle_type,'version':1,'decision':payload.decision,
        'assessment_id':plan.assessment_id if plan else None,
        'body':payload.body,'limitations':payload.limitations,'reason':payload.reason,'input_digest':payload.input_digest,
        'payload_digest':row.payload_digest,'review_context_digest':canonical_digest(ctx),'created_at':reviews._utc(now),'confirmed':True,
        'next_cycle_id':next_cycle_id,'next_plan_version_id':next_plan_id,'next_assessment_id':next_assessment_id,
        'source_ai_decision_id':payload.source_ai_decision_id,
        'original_request':values,'authorization_snapshot':ctx['authorization_snapshot'],'professional_confirmation':plan is not None}
    row.snapshot={'metadata':metadata(row),'payload':values,'ack':ack,'input_snapshot':inputs,'authorization_snapshot':ctx['authorization_snapshot'],
        'credential_snapshot':ctx['credential_snapshot']}
    db.add(row); db.flush()
    from backend.app.services.event_service import append_care_event
    append_care_event(db,patient_id=cycle.patient_id,actor_user_id=user.id,event_type='cycle_review_confirmed',aggregate_type='cycle_review',
        aggregate_id=row.id,revision=1,payload={'cycle_id':cycle.id,'cycle_review_id':row.id,'decision':row.decision,
            'next_cycle_id':next_cycle_id,'next_assessment_id':next_assessment_id,'authorization_snapshot':ctx['authorization_snapshot']},
        dedupe_key='cycle_review:'+payload.client_cycle_review_id,actor_identity_basis=ctx['actor_identity_basis'])
    reviews._audit(db,user,cycle.patient_id,'cycle_review_confirmed',{'cycle_review_id':row.id,'decision':row.decision})
    return _ack(row),True
