from datetime import date
from time import sleep
from backend.tests.test_review_drafts import context_and_body
from backend.tests.test_report_publications import publication_body


def _actual_run(client,doctor,session,intent,label):
    from backend.app.db.session import SessionLocal
    from backend.app.models.agent import AgentRun
    from sqlalchemy import select
    ctx=client.get(f"/api/v1/agent/run-context?patient_id={session['patient_id']}",headers=doctor).json()
    result=client.post('/api/v1/agent/runs',headers=doctor,json={'client_run_id':label,'patient_id':session['patient_id'],
        'intent':intent,'assessment_id':session['id'],'cycle_id':None,'message':'请按实际材料准备草稿，待本人核对。',
        'expected_context_digest':ctx['input_digest'],'run_context':ctx['run_context']})
    assert result.status_code==202,result.text
    identifier=result.json()['run_id']
    for _ in range(300):
        with SessionLocal() as db:
            if db.scalar(select(AgentRun.status).where(AgentRun.id==identifier)) not in {'queued','running'}: break
        sleep(.05)
    read=client.get(f'/api/v1/agent/runs/{identifier}',headers=doctor)
    assert read.status_code==200 and read.json()['status']=='completed',read.text
    return read.json()['artifact']


def _adopt(client,doctor,artifact,label,*,edited=None):
    ctx=client.get(f"/api/v1/agent/artifacts/{artifact['id']}/decision-context",headers=doctor)
    assert ctx.status_code==200,ctx.text
    saved=client.post('/api/v1/agent/artifact-decisions',headers=doctor,json={'client_decision_id':label,
        'patient_id':artifact['patient_id'],'artifact_id':artifact['id'],'expected_previous_version':ctx.json()['expected_previous_version'],
        'decision_context':ctx.json()['decision_context'],'decision':'edit' if edited is not None else 'adopt',
        'content':edited if edited is not None else ctx.json()['default_content'],'reason':'实际负责医生已核对来源和内容。','confirmed':True})
    assert saved.status_code==201,saved.text
    return saved.json()


def test_human_review_plan_and_reply_adoption_reach_actual_business_and_preserve_exact_ai_provenance(client):
    owner,doctor,_,session,_,draft=context_and_body(client)
    summary=_actual_run(client,doctor,session,'assessment_summary','summary-for-actual-review')
    chosen=_adopt(client,doctor,summary,'summary-human-adopted')
    review_body={**draft,'client_review_id':chosen['target_client_id'],'body':chosen['content']['text'],'source_ai_decision_id':chosen['id']}
    wrong=client.post('/api/v1/care/reviews',headers=doctor,json={**review_body,'body':'与已核对草稿不同的正文。'})
    assert wrong.status_code==409,wrong.text
    review=client.post('/api/v1/care/reviews',headers=doctor,json=review_body)
    assert review.status_code==201,review.text
    assert review.json()['source_ai_decision_id']==chosen['id'] and review.json()['status']=='draft'
    report=client.post('/api/v1/care/review-publications',headers=doctor,json=publication_body(client,doctor,review.json()))
    assert report.status_code==201,report.text
    published=client.get(f"/api/v1/care/reports/{report.json()['id']}",headers=owner)
    assert published.status_code==200 and published.json()['source_ai_decision_id']==chosen['id']
    assert published.json()['ai_draft_status']=='human_reviewed_source' and published.json()['body']==chosen['content']['text']
    plan_artifact=_actual_run(client,doctor,session,'plan_draft','plan-for-actual-publication')
    content={key:plan_artifact['body']['plan_draft'][key] for key in ('title','instructions','source_report_id')}
    content['instructions']='医生核对后的实际安排：按真实日期记录；缺失保持为空。'
    plan_decision=_adopt(client,doctor,plan_artifact,'plan-human-edited',edited=content)
    ctx=client.get(f"/api/v1/care/assessments/{session['id']}/plan-context",headers=doctor).json()
    body={key:ctx[key] for key in ('patient_id','assessment_id','expected_previous_version','expected_plan_revision','source_report_id','input_digest','plan_context')}
    body.update(client_plan_version_id=plan_decision['target_client_id'],expected_assessment_version=ctx['assessment_version'],
        title=content['title'],instructions=content['instructions'],start_date=ctx['calendar_today'],end_date=ctx['calendar_today'],
        source_ai_decision_id=plan_decision['id'],confirmed=True)
    bad=client.post('/api/v1/care/plan-versions',headers=doctor,json={**body,'instructions':'另一个未核对安排。'})
    assert bad.status_code==409,bad.text
    plan=client.post('/api/v1/care/plan-versions',headers=doctor,json=body)
    assert plan.status_code==201,plan.text
    assert plan.json()['source_ai_decision_id']==plan_decision['id'] and plan.json()['cycle_id']
    reply=_actual_run(client,doctor,session,'reply_draft','reply-for-actual-recipient')
    reply_decision=_adopt(client,doctor,reply,'reply-human-adopted')
    relationships=client.get(f"/api/v1/care/shared-messages/relationships?patient_id={session['patient_id']}",headers=doctor)
    assert relationships.status_code==200,relationships.text
    rel=next(row for row in relationships.json()['items'] if row['doctor_user_id']==session['responsible_doctor_id'] and row['can_send'])
    message={'patient_id':session['patient_id'],'relationship_id':rel['relationship_id'],'client_message_id':reply_decision['target_client_id'],
        'content':reply_decision['content']['text'],'send_context':rel['send_context'],'source_ai_decision_id':reply_decision['id'],'confirmed':True}
    denied=client.post('/api/v1/care/shared-messages',headers=doctor,json={**message,'content':'其他正文。'})
    assert denied.status_code==409,denied.text
    sent=client.post('/api/v1/care/shared-messages',headers=doctor,json=message)
    assert sent.status_code==201,sent.text
    assert sent.json()['source_ai_decision_id']==reply_decision['id']
    assert client.get(f"/api/v1/care/shared-messages/submissions/{reply_decision['target_client_id']}",headers=doctor).json()==sent.json()
    actual=client.get(f"/api/v1/care/shared-messages?patient_id={session['patient_id']}&relationship_id={rel['relationship_id']}",headers=owner)
    assert actual.status_code==200 and actual.json()['items'][0]['content']==reply_decision['content']['text']
