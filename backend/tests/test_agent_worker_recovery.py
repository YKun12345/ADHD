"""Real persisted queued and crashed-lease runs survive API/process scheduling loss."""
from datetime import datetime,timedelta,timezone
from time import sleep
from backend.tests.test_review_drafts import context_and_body


def test_persisted_runs_are_recovered_without_an_open_page_and_terminal_runs_are_not_reexecuted(client,monkeypatch):
    owner,_,_,session,_,_=context_and_body(client)
    from backend.app.services.agent import runner
    from backend.app.db.session import SessionLocal
    from backend.app.models.agent import AgentRun,run_state
    # Simulate a response committed just before the process scheduler is lost.
    real_schedule=runner.schedule_run
    monkeypatch.setattr(runner,'schedule_run',lambda *args:False)
    ids=[]
    for label in ('persisted-queued','persisted-expired-running'):
        ctx=client.get(f"/api/v1/agent/run-context?patient_id={session['patient_id']}",headers=owner).json()
        result=client.post('/api/v1/agent/runs',headers=owner,json={'client_run_id':label,'patient_id':session['patient_id'],
            'intent':'assessment_summary','assessment_id':session['id'],'cycle_id':None,'message':'读取实际保存材料。',
            'expected_context_digest':ctx['input_digest'],'run_context':ctx['run_context']})
        assert result.status_code==202,result.text
        ids.append(result.json()['run_id'])
    with SessionLocal() as db:
        lost=db.get(AgentRun,ids[1]); lost.status='running'; lost.attempt_count=1; lost.lease_token='synthetic-crashed-process'
        lost.lease_expires_at=datetime.now(timezone.utc)-timedelta(seconds=1); lost.state_snapshot=run_state(lost); db.commit()
    monkeypatch.setattr(runner,'schedule_run',real_schedule)
    from backend.app.workers.agent_worker import scan_once
    assert scan_once(SessionLocal,limit=10)==2
    for _ in range(200):
        with SessionLocal() as db:
            rows=[db.get(AgentRun,value) for value in ids]
            if all(row.status=='completed' for row in rows):
                assert [row.attempt_count for row in rows]==[1,2]
                artifacts=[row.artifact_id for row in rows]; assert all(artifacts) and len(set(artifacts))==2
                break
        sleep(0.05)
    else:
        raise AssertionError('Persisted runs must recover without any run GET or open mini page')
    assert scan_once(SessionLocal,limit=10)==0
    with SessionLocal() as db:
        assert [db.get(AgentRun,value).artifact_id for value in ids]==artifacts
    # An external request may already have been billed when its process died.
    # Preserve the reservation and never auto-dispatch it a second time.
    grant=client.post('/api/v1/patient/consents',headers=owner,json={'patient_id':session['patient_id'],'purpose':'external_ai',
        'scope':['assessment'],'terms_version':'W02-1'})
    assert grant.status_code==201,grant.text
    monkeypatch.setattr(runner,'schedule_run',lambda *args:False)
    ctx=client.get(f"/api/v1/agent/run-context?patient_id={session['patient_id']}",headers=owner).json()
    pending=client.post('/api/v1/agent/runs',headers=owner,json={'client_run_id':'unconfirmed-external-dispatch','patient_id':session['patient_id'],
        'intent':'assessment_summary','assessment_id':session['id'],'cycle_id':None,'message':'实际阶段材料摘要。',
        'expected_context_digest':ctx['input_digest'],'run_context':ctx['run_context']})
    assert pending.status_code==202,pending.text
    unknown_id=pending.json()['run_id']
    with SessionLocal() as db:
        lost=db.get(AgentRun,unknown_id); lost.status='running'; lost.attempt_count=1; lost.model_round_count=1
        lost.model_name='synthetic-prior-process-provider'; lost.estimated_cost_microunits=999
        lost.lease_token='unconfirmed-provider-process'; lost.lease_expires_at=datetime.now(timezone.utc)-timedelta(seconds=1)
        lost.state_snapshot=run_state(lost); db.commit()
    monkeypatch.setattr(runner,'schedule_run',real_schedule)
    from backend.app.services.agent import provider
    called=[]
    monkeypatch.setattr(provider,'run_provider',lambda *args,**kw:called.append(True))
    assert scan_once(SessionLocal,limit=10)==1
    for _ in range(100):
        with SessionLocal() as db:
            row=db.get(AgentRun,unknown_id)
            if row.status=='failed':
                assert row.error_code=='provider_outcome_unknown' and row.model_round_count==1
                assert row.estimated_cost_microunits==999 and row.artifact_id is None and not called
                break
        sleep(.05)
    else:
        raise AssertionError('Unknown external outcome must stop without spending its budget again')
