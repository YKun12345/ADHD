from __future__ import annotations
import json
import pytest
from sqlalchemy import select, text

@pytest.fixture
def actors(client):
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User, UserRole, UserSubrole
    from backend.app.models.patient import Patient, PatientType
    from backend.app.core.security import create_access_token
    with SessionLocal() as db:
        users=[]
        for label,role,sub in [('doctor',UserRole.RESEARCHER,UserSubrole.NORMAL),('outsider',UserRole.RESEARCHER,UserSubrole.NORMAL),('dac',UserRole.RESEARCHER,UserSubrole.DAC),('dac2',UserRole.RESEARCHER,UserSubrole.DAC),('patient',UserRole.PATIENT,None)]:
            u=User(email=label+'@example.org',full_name=label+'-private-name',password_hash='unused',role=role,subrole=sub,consent_agreed=True,is_active=True)
            db.add(u); db.flush(); users.append(u)
        p=Patient(user_id=users[4].id,assigned_researcher_id=users[0].id,patient_type=PatientType.ADULT)
        db.add(p); db.commit()
        result={u.full_name.split('-')[0]: {'id':u.id,'headers':{'Authorization':'Bearer '+create_access_token(str(u.id),u.role.value)}} for u in users}
        result['patient_id']=p.id
    return result

def initialize(client,actors):
    assert client.post('/api/v1/security/system/init',headers=actors['dac']['headers']).status_code == 200

def test_management_requires_dac(client,actors):
    for method,path in [('post','system/init'),('get','system/key_assignments'),('get','system/mcs_nodes'),('get','system/patient_assignments')]:
        r=getattr(client,method)('/api/v1/security/'+path,headers=actors['outsider']['headers'])
        assert r.status_code == 403, path

def test_patient_security_binding_and_dac_identity(client,actors):
    initialize(client,actors)
    for who in ['outsider','dac2']:
        for suffix in ['overview','cipher_records']:
            r=client.get(f'/api/v1/security/patient/{actors["patient_id"]}/{suffix}',headers=actors[who]['headers'])
            assert r.status_code in (403,404), (who,suffix)
    r=client.get('/api/v1/security/dac/patients',headers=actors['dac']['headers'])
    assert r.status_code==200
    assert 'patient-private-name' not in r.text and 'patient@example.org' not in r.text
    r=client.get('/api/v1/security/system/key_assignments',headers=actors['dac']['headers'])
    assert 'patient-private-name' not in r.text and 'patient@example.org' not in r.text

def test_cognitive_explicit_units(client):
    from backend.app.models.cognitive_test import CognitiveTest
    from backend.app.services.security_service import _extract_cognitive_dimensions
    item=CognitiveTest(test_type='reaction',result_json={'protocol_schema_version':6,'accuracy':80,'mean_rt_ms':420,'correct_trials':20,'total_trials':25,'completed':True})
    values=_extract_cognitive_dimensions(item)
    assert values['accuracy_score']==80 and values['latency_score']==420

def make_scale(actors):
    from backend.app.db.session import SessionLocal
    from backend.app.models.patient import Patient
    from backend.app.models.scale_result import ScaleResult
    from backend.app.services.security_service import capture_scale_result_cipher
    with SessionLocal() as db:
        item=ScaleResult(patient_id=actors['patient_id'],scale_type='asrs',score_json={'secret_note':'private-clinical-payload','radar_scores':{}},total_score=18,risk_level='low')
        db.add(item); db.flush()
        cipher=capture_scale_result_cipher(db,db.get(Patient,actors['patient_id']),item)
        db.commit()
        return item.id,cipher.id,cipher.encrypted_payload,cipher.integrity_digest

def test_source_tamper_backfill_preserves_evidence(client,actors):
    initialize(client,actors)
    source_id,cipher_id,payload,digest=make_scale(actors)
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    from backend.app.models.security import SecurityCipherRecord
    from backend.app.services.security_service import sync_security_runtime_entities
    with SessionLocal() as db:
        db.get(ScaleResult,source_id).total_score=25; db.commit()
        sync_security_runtime_entities(db); db.commit()
        record=db.get(SecurityCipherRecord,cipher_id)
        assert (record.encrypted_payload,record.integrity_digest)==(payload,digest)
    r=client.post('/api/v1/security/dac/temporal_audits',headers=actors['dac']['headers'],json={'patient_id':actors['patient_id'],'source_type':'scale'})
    assert r.status_code==200,r.text
    assert r.json()['verification_passed'] is False
    assert not r.json()['decrypted_stats'].get('stats')

def test_legitimate_updates_append_versions(client,actors):
    initialize(client,actors)
    source_id,old_id,payload,digest=make_scale(actors)
    from backend.app.db.session import SessionLocal
    from backend.app.models.patient import Patient
    from backend.app.models.scale_result import ScaleResult
    from backend.app.models.security import SecurityCipherRecord
    from backend.app.services.security_service import capture_scale_result_cipher
    with SessionLocal() as db:
        item=db.get(ScaleResult,source_id); item.total_score=25
        new=capture_scale_result_cipher(db,db.get(Patient,actors['patient_id']),item)
        assert new.id != old_id
        db.commit()
        assert db.get(SecurityCipherRecord,old_id).integrity_digest == digest
    r=client.post('/api/v1/security/dac/temporal_audits',headers=actors['dac']['headers'],json={'patient_id':actors['patient_id'],'source_type':'scale'})
    assert r.json()['verification_passed'] is True,r.text
    assert r.json()['decrypted_stats']['record_count']==1
    assert r.json()['decrypted_stats']['stats']['total_score']['sum']==250

def test_database_and_upload_are_encrypted(client,actors,tmp_path):
    initialize(client,actors); source_id,*_=make_scale(actors)
    from backend.app.db.session import engine,SessionLocal
    from backend.app.models.scale_result import ScaleResult
    from backend.app.services.upload_storage import store_timeseries_upload,read_stored_upload
    content=b'1,2,3\n4,5,6\n'
    stored=store_timeseries_upload(content,'sample.csv',tmp_path,1024)
    assert stored.stored_path.read_bytes() != content
    assert read_stored_upload(stored.stored_path)==content
    with engine.connect() as conn:
        raw=conn.execute(text('select score_json,total_score from scale_results where id=:id'),{'id':source_id}).first()
        assert 'private-clinical-payload' not in str(raw) and 'aesgcm:v1:' in str(raw)
        secret=conn.execute(text('select secret_params_json from security_system_configs')).scalar()
        assert 'aesgcm:v1:' in str(secret) and 'lambda' not in str(secret)
    with SessionLocal() as db:
        assert db.get(ScaleResult,source_id).total_score==18

def test_audit_hash_chain_detects_altered_log(client,actors):
    initialize(client,actors)
    from backend.app.db.session import SessionLocal
    from backend.app.models.security import SecurityAuditLog
    from backend.app.services.security_service import verify_audit_log_chain
    with SessionLocal() as db:
        assert verify_audit_log_chain(db)['verified'] is True
        row=db.scalar(select(SecurityAuditLog).order_by(SecurityAuditLog.id)); row.message='altered'; db.commit()
        assert verify_audit_log_chain(db)['verified'] is False


def test_ai_logs_record_provider_model_mode_and_encrypt_content(client,actors,monkeypatch):
    from backend.app.api.routes import ai
    from backend.app.db.session import SessionLocal,engine
    from backend.app.models.ai_chat_log import AIChatLog
    monkeypatch.setattr(ai,'generate_chat_reply',lambda **kwargs: ('local private answer','fallback-template',True))
    response=client.post('/api/v1/ai/chat',headers=actors['patient']['headers'],json={'message':'private conversation','context_scope':'general','conversation':[]})
    assert response.status_code==200,response.text
    with SessionLocal() as db:
        rows=db.scalars(select(AIChatLog).order_by(AIChatLog.id)).all()
        assert len(rows)==2
        assert all(row.provider=='local' and row.model_name=='fallback-template' and row.mode=='local_fallback' and row.created_at for row in rows)
    with engine.connect() as conn:
        assert 'private conversation' not in str(conn.execute(text('select content from ai_chat_logs')).all())
