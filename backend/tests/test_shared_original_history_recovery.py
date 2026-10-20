from backend.tests.test_care_message_scope import message_world
from backend.tests.test_shared_message_routes import send_context


def test_actual_original_message_ack_is_a_legal_history_read_after_basic_withdrawal_while_posts_keep_processing_guards(client):
    _,owner,pid,doctors=message_world(client)
    _,doctor,relationship=doctors[0]
    originals=[]
    for label,headers in [('owner',owner),('doctor',doctor)]:
        ctx=send_context(client,headers,pid,relationship['id'])
        body={'patient_id':pid,'relationship_id':relationship['id'],'client_message_id':'history-ack-'+label,
            'content':'合成实际发送内容，仅原发送者恢复确认。','send_context':ctx['send_context'],'confirmed':True}
        response=client.post('/api/v1/care/shared-messages',headers=headers,json=body)
        assert response.status_code==201,response.text
        originals.append((headers,body,response.json()))
    basic=next(row for row in client.get(f'/api/v1/patient/consents?patient_id={pid}',headers=owner).json()['items'] if row['purpose']=='basic_use')
    assert client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw",headers=owner,json={'expected_revision':basic['revision']}).status_code==200
    for headers,body,ack in originals:
        recovered=client.get('/api/v1/care/shared-messages/submissions/'+body['client_message_id'],headers=headers)
        assert recovered.status_code==200,recovered.text
        assert recovered.json()==ack
        assert client.post('/api/v1/care/shared-messages',headers=headers,json=body).status_code==403
    granted=client.post('/api/v1/patient/consents',headers=owner,json={'patient_id':pid,'purpose':'basic_use','scope':basic['scope'],'terms_version':'W02-1'})
    assert granted.status_code==201,granted.text
    for headers,body,ack in originals:
        assert client.get('/api/v1/care/shared-messages/submissions/'+body['client_message_id'],headers=headers).json()==ack
        assert client.post('/api/v1/care/shared-messages',headers=headers,json=body).status_code==409
    revoked=client.post(f"/api/v1/care/relationships/{relationship['id']}/revoke",headers=owner,json={'expected_revision':relationship['revision']})
    assert revoked.status_code==200,revoked.text
    assert client.get('/api/v1/care/shared-messages/submissions/history-ack-owner',headers=owner).json()==originals[0][2]
    assert client.get('/api/v1/care/shared-messages/submissions/history-ack-doctor',headers=doctor).status_code==403
    assert client.get('/api/v1/care/shared-messages/submissions/history-ack-owner',headers=doctor).status_code==403
