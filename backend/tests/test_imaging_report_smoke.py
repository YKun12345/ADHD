from backend.tests.test_assessment_sessions import doctor_session


def test_analysis_creates_readable_version_and_real_doctor_publishes_a_separate_immutable_version(client):
    _,owner,pid,_,doctor,_=doctor_session(client)
    generated=client.post(f'/api/v1/model/predict_mock?patient_id={pid}',headers=owner)
    assert generated.status_code==200,generated.text
    listing=client.get(f'/api/v1/care/imaging-reports?patient_id={pid}',headers=owner)
    assert listing.status_code==200,listing.text
    first=listing.json()['items'][0]
    assert first['publisher_kind']=='system' and first['professional_review_status']=='not_reviewed'
    prediction_id=generated.json()['prediction_id']
    context=client.get(f'/api/v1/care/imaging-reports/publication-context?patient_id={pid}&prediction_id={prediction_id}',headers=doctor)
    assert context.status_code==200,context.text
    body={key:context.json()[key] for key in ('patient_id','prediction_id','expected_previous_version','input_digest','publication_context')}
    body.update(client_publication_id='synthetic-doctor-image-review',body='医生核对演示来源及局限，不作真实影像诊断。',limitations='此为mock演示，不能用于诊断。',confirmed=True)
    published=client.post('/api/v1/care/imaging-reports',headers=doctor,json=body)
    assert published.status_code==201,published.text
    assert published.json()['version']==2 and published.json()['demonstration_only'] is True
    read=client.get(f"/api/v1/care/imaging-reports/{published.json()['id']}",headers=owner)
    assert read.status_code==200 and read.json()['body']==body['body'],read.text
    assert read.json()['raw_image_session_included'] is False
    original=client.get('/api/v1/care/imaging-reports/submissions/synthetic-doctor-image-review',headers=doctor)
    assert original.json()==published.json()
    old=client.get(f"/api/v1/care/imaging-reports/{first['id']}",headers=owner)
    assert old.json()==first
