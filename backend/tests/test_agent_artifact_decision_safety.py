from fastapi import HTTPException
from backend.tests.test_review_drafts import context_and_body
from backend.tests.test_agent_artifact_business import _actual_run,_adopt


def test_rejection_replaces_adoption_history_remains_private_and_audit_failure_rolls_back_new_human_version(client,monkeypatch):
    owner,doctor,_,session,_,_=context_and_body(client)
    artifact=_actual_run(client,doctor,session,'review_questions','disposition-safety-source')
    chosen=_adopt(client,doctor,artifact,'first-actual-human-adoption')
    route=f"/api/v1/agent/artifacts/{artifact['id']}/decision-context"
    ctx=client.get(route,headers=doctor).json()
    rejection={'client_decision_id':'actual-human-rejection','patient_id':session['patient_id'],'artifact_id':artifact['id'],
        'expected_previous_version':1,'decision_context':ctx['decision_context'],'decision':'reject','content':None,
        'reason':'本人重新核对后决定不使用这个问题。','confirmed':True}
    rejected=client.post('/api/v1/agent/artifact-decisions',headers=doctor,json=rejection)
    assert rejected.status_code==201,rejected.text
    assert rejected.json()['target_type'] is None and rejected.json()['target_client_id'] is None
    assert client.get(f"/api/v1/agent/artifact-decisions/{chosen['id']}/adoption-context",headers=doctor).status_code==409
    history_url=f"/api/v1/agent/artifacts/{artifact['id']}/decisions"
    assert client.get(history_url,headers=owner).status_code==403
    records=client.get(history_url,headers=doctor)
    assert records.status_code==200 and [row['decision'] for row in records.json()['items']]==['reject','adopt']
    assert records.json()['items'][1]['content']==chosen['content']
    ctx=client.get(route,headers=doctor).json()
    edited={'client_decision_id':'failed-then-retried-human-edit','patient_id':session['patient_id'],'artifact_id':artifact['id'],
        'expected_previous_version':2,'decision_context':ctx['decision_context'],'decision':'edit',
        'content':{**chosen['content'],'question':'请说明实际中断环境；不知道可说明。'},'reason':'本人已根据真实原件改写。','confirmed':True}
    from backend.app.services import review_service
    original=review_service._audit
    def denied(db,user,pid,action,detail):
        if action=='agent_artifact_decision':raise HTTPException(503,'synthetic critical human audit failure')
        return original(db,user,pid,action,detail)
    monkeypatch.setattr(review_service,'_audit',denied)
    assert client.post('/api/v1/agent/artifact-decisions',headers=doctor,json=edited).status_code==503
    monkeypatch.setattr(review_service,'_audit',original)
    assert client.get('/api/v1/agent/artifact-decisions/submissions/failed-then-retried-human-edit',headers=doctor).status_code==404
    assert len(client.get(history_url,headers=doctor).json()['items'])==2
    saved=client.post('/api/v1/agent/artifact-decisions',headers=doctor,json=edited)
    assert saved.status_code==201 and saved.json()['version']==3,saved.text
    assert client.get('/api/v1/agent/artifact-decisions/submissions/failed-then-retried-human-edit',headers=doctor).json()==saved.json()
    assert client.get(f"/api/v1/care/assessments/{session['id']}/clarifications",headers=owner).json()['items']==[]
