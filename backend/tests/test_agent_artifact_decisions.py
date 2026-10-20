from time import sleep
from backend.tests.test_review_drafts import context_and_body


def actual_question_artifact(client):
    owner,doctor,_,session,_,_=context_and_body(client)
    ctx=client.get(f"/api/v1/agent/run-context?patient_id={session['patient_id']}",headers=doctor).json()
    saved=client.post('/api/v1/agent/runs',headers=doctor,json={'client_run_id':'actual-question-draft','patient_id':session['patient_id'],
        'intent':'review_questions','assessment_id':session['id'],'cycle_id':None,'message':'请针对实际有局限的提交准备补问草稿。',
        'expected_context_digest':ctx['input_digest'],'run_context':ctx['run_context']})
    assert saved.status_code==202,saved.text
    for _ in range(100):
        result=client.get(f"/api/v1/agent/runs/{saved.json()['run_id']}",headers=doctor)
        if result.json().get('status') not in {'queued','running'}: break
        sleep(.05)
    assert result.status_code==200 and result.json()['status']=='completed',result.text
    return owner,doctor,session,result.json()['artifact']


def test_actual_doctor_can_edit_a_private_draft_and_use_it_only_for_its_real_bound_question(client):
    owner,doctor,session,artifact=actual_question_artifact(client)
    route=f"/api/v1/agent/artifacts/{artifact['id']}/decision-context"
    response=client.get(route,headers=doctor)
    assert response.status_code==200,response.text
    ctx=response.json(); question=artifact['body']['questions'][0]
    content={'source_type':question['source_type'],'source_key':question['source_key'],'question':'请补充这次操作中断时的实际情况，不知道可以说明。'}
    assert client.get(route,headers=owner).status_code==403
    body={'client_decision_id':'actual-edited-question','patient_id':session['patient_id'],'artifact_id':artifact['id'],
        'expected_previous_version':0,'decision_context':ctx['decision_context'],'decision':'edit','content':content,
        'reason':'负责医生已核对原件并修改提问。','confirmed':True}
    saved=client.post('/api/v1/agent/artifact-decisions',headers=doctor,json=body)
    assert saved.status_code==201,saved.text
    decision=saved.json()
    assert decision['target_type']=='review_question' and decision['content']==content
    assert client.get('/api/v1/agent/artifact-decisions/submissions/actual-edited-question',headers=doctor).json()==decision
    assert client.get(f"/api/v1/care/assessments/{session['id']}/clarifications",headers=owner).json()['items']==[]
    preflight=client.get(f"/api/v1/care/assessments/{session['id']}/review-context",headers=doctor).json()
    request={'client_question_id':decision['target_client_id'],'patient_id':session['patient_id'],'assessment_id':session['id'],
        'expected_assessment_version':preflight['assessment_version'],'input_digest':preflight['input_digest'],'review_context':preflight['review_context'],
        **content,'source_ai_decision_id':decision['id'],'confirmed':True}
    wrong=client.post('/api/v1/care/clarifications',headers=doctor,json={**request,'question':'与实际人工核对决定不同的问题。'})
    assert wrong.status_code==409,wrong.text
    actual=client.post('/api/v1/care/clarifications',headers=doctor,json=request)
    assert actual.status_code==201,actual.text
    assert actual.json()['source_ai_decision_id']==decision['id'] and actual.json()['question']==content['question']
    assert client.get(f"/api/v1/care/clarifications/submissions/{decision['target_client_id']}",headers=doctor).json()==actual.json()
    assert client.get(f"/api/v1/agent/artifact-decisions/{decision['id']}/adoption-context",headers=doctor).status_code==409
