from datetime import date, timedelta
from sqlalchemy import select, func
from fastapi import HTTPException
from backend.tests.test_cycle_reviews import actual_plan
from backend.tests.test_assessment_sessions import actor


def test_next_round_and_end_critical_failure_rollback_every_business_object_before_same_original_retry(client,monkeypatch):
    owner,doctor,_,session,plan,record,day=actual_plan(client)
    from backend.app.services import review_service
    from backend.app.db.session import SessionLocal
    from backend.app.models.assessment import AssessmentSession
    from backend.app.models.care_plan import CarePlan
    from backend.app.models.review import CycleReview
    from backend.app.models.event import CareEvent
    ctx=client.get(f"/api/v1/care/cycles/{plan['cycle_id']}/review-context",headers=doctor).json()
    body={'client_cycle_review_id':'atomic-next-round','patient_id':session['patient_id'],'cycle_id':plan['cycle_id'],
        'expected_previous_version':0,'input_digest':ctx['input_digest'],'review_context':ctx['review_context'],
        'decision':'next_round','body':'实际阶段意见。','limitations':'合成验证，不是疗效。','reason':'需要新独立批次。','followup_plan':None,'next_cycle':None,'confirmed':True}
    original=review_service._audit
    def failing(db,user,pid,action,detail):
        if action=='cycle_review_confirmed': raise HTTPException(503,'synthetic critical stage audit failure')
        return original(db,user,pid,action,detail)
    with SessionLocal() as db:
        before=db.scalar(select(func.count()).select_from(AssessmentSession)); revision=db.get(CarePlan,plan['plan_id']).revision
    monkeypatch.setattr(review_service,'_audit',failing)
    failed=client.post('/api/v1/care/cycle-reviews',headers=doctor,json=body)
    assert failed.status_code==503,failed.text
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(AssessmentSession))==before
        root=db.get(CarePlan,plan['plan_id']); assert root.status=='active' and root.revision==revision
        assert db.scalar(select(CycleReview.id).where(CycleReview.client_cycle_review_id==body['client_cycle_review_id'])) is None
        assert db.scalar(select(CareEvent.id).where(CareEvent.event_type=='cycle_review_confirmed')) is None
    monkeypatch.setattr(review_service,'_audit',original)
    saved=client.post('/api/v1/care/cycle-reviews',headers=doctor,json=body)
    assert saved.status_code==201,saved.text
    assert saved.json()['next_assessment_id'] and saved.json()['professional_confirmation'] is True


def test_actual_self_next_cycle_is_independent_and_explicit_closure_stops_old_writes_but_keeps_history(client):
    _,owner,pid=actor(client,suffix='self-stage')
    day=date.today()
    # Server calendar is authoritative even on hosts with another timezone.
    from backend.app.services.care_plan_service import today
    day=today()
    cycle=client.post('/api/v1/care/cycles',headers=owner,json={'patient_id':pid,'client_cycle_id':'first-self-stage','start_date':str(day),'end_date':str(day)})
    assert cycle.status_code==201,cycle.text
    cid=cycle.json()['id']; ctx=client.get(f'/api/v1/care/cycles/{cid}/review-context',headers=owner)
    assert ctx.status_code==200,ctx.text
    body={'client_cycle_review_id':'actual-self-next-cycle','patient_id':pid,'cycle_id':cid,'expected_previous_version':0,
        'input_digest':ctx.json()['input_digest'],'review_context':ctx.json()['review_context'],'decision':'next_round',
        'body':'本人核对实际记录。','limitations':'尚无实际记录，不判断改善。','reason':'另建独立日期周期。','followup_plan':None,
        'next_cycle':{'start_date':str(day+timedelta(days=1)),'end_date':str(day+timedelta(days=2))},'confirmed':True}
    result=client.post('/api/v1/care/cycle-reviews',headers=owner,json=body)
    assert result.status_code==201,result.text
    ack=result.json(); assert ack['professional_confirmation'] is False and ack['next_plan_version_id'] is None
    assert ack['next_assessment_id'] is None and ack['next_cycle_id']!=cid
    old=client.get(f'/api/v1/care/cycles/{cid}',headers=owner).json()
    assert old['processing_status']=='ended' and not old['allowed_actions'] and not old['records']
    denied=client.post('/api/v1/care/daily-records',headers=owner,json={'client_submission_id':'closed-self-write','patient_id':pid,'cycle_id':cid,
        'record_date':str(day),'expected_revision':0,'content':{'note':'旧周期已结束，不应写入。'}})
    assert denied.status_code==409,denied.text
    fresh=client.get(f"/api/v1/care/cycles/{ack['next_cycle_id']}",headers=owner).json()
    assert fresh['start_date']==str(day+timedelta(days=1)) and not fresh['records'] and fresh['responsible_doctor_id'] is None
    assert client.get('/api/v1/care/cycle-reviews/submissions/actual-self-next-cycle',headers=owner).json()==ack
