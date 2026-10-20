"""Full web engine keeps the original frozen trials and truthful source."""
import json
from pathlib import Path
import subprocess
import pytest
from backend.tests.test_assessment_sessions import actor,created,start


@pytest.mark.parametrize('task',['reaction','stroop','flanker','nback','trail','digit'])
def test_full_web_trials_require_actual_web_attempt_and_original_source(client,task):
    _,owner,pid=actor(client,suffix='web-cognition-'+task)
    session=created(client,owner,pid)
    item=next(row for row in session['items'] if row['key']==task)
    response=start(client,owner,item,pid,device={'platform':'web','device_type':'browser','viewport_width':1280,'viewport_height':800},input={'method':'mouse'})
    assert response.status_code==201,response.text
    attempt=response.json()
    evidence=json.loads(subprocess.run(['node',str(Path(__file__).with_name('w04_cognitive_fixture.cjs'))],input=json.dumps({'config':item['config'],'run_id':attempt['run_id']}),capture_output=True,text=True,encoding='utf-8',check=True).stdout)
    evidence['payload']['result_json']['source']='patient_web'
    metadata={key:attempt['metadata'][key] for key in ('device','input','timing','practice','assistance')}
    metadata.update(practice={'completed':True,'attempts':1,'exposure_count':attempt['metadata']['practice']['exposure_count']},interrupted_count=0,practice_records=evidence['practice_records'])
    body={'submission_id':'web-'+attempt['run_id'],'kind':'cognitive','patient_id':pid,'assessment_id':session['id'],'assessment_item_id':item['id'],'attempt_id':attempt['id'],'run_id':attempt['run_id'],'task_id':None,
          **{key:attempt[key] for key in ('protocol_id','protocol_schema_version','config_digest','template_digest','actor_user_id','performer_kind','performer_user_id','performer_patient_id','respondent_user_id','respondent_kind','submitter_user_id')},'content':{**evidence['payload'],'execution_metadata':metadata}}
    body['content']['result_json']['source']='miniprogram'
    assert client.post('/api/v1/care/submissions',headers=owner,json=body).status_code==422
    body['content']['result_json']['source']='patient_web'
    saved=client.post('/api/v1/care/submissions',headers=owner,json=body)
    assert saved.status_code==201,saved.text
    assert saved.json()['comparability_status']=='not_verified'
    original=client.get('/api/v1/care/submissions/'+body['submission_id']+'/evidence',headers=owner)
    assert original.status_code==200,original.text
    assert original.json()['client_evidence']['result_json']['source']=='patient_web'
