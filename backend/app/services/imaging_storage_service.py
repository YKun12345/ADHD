"""Fail-closed image storage gates and one-transaction critical write evidence."""
from datetime import datetime, timezone
import hashlib
import json
from fastapi import HTTPException
from sqlalchemy import select
from backend.app.models.imaging_storage import canonical_metadata
from backend.app.models.model_prediction import ModelPrediction
from backend.app.models.imaging_visualization import ImagingVisualization
from backend.app.services.identity_access import recheck_request_authority


def imaging_history_status(db, patient_id):
    from backend.app.db.imaging_migration import missing_storage_columns, storage_schema_issues
    if missing_storage_columns(db.connection()) or storage_schema_issues(db.connection()):
        return 'storage_upgrade_required'
    for model in (ModelPrediction, ImagingVisualization):
        # Never ask an ORM decryptor to guess an unconverted row's format.
        for row in db.execute(select(model.__table__).where(model.__table__.c.patient_id == patient_id)).mappings():
            if row['envelope_status'] not in {'bound','migrated_from_legacy'}:
                if row['record_origin'] is not None or any(isinstance(row[f],str) and row[f].startswith('aesgcm:v2:') for f in model.record_fields):
                    from backend.app.core.record_envelope import RecordIntegrityError
                    raise RecordIntegrityError('Authenticated image data cannot be downgraded to legacy.')
                return 'conversion_required'
    return 'ready'


def require_imaging_storage(db, patient_id):
    state = imaging_history_status(db,patient_id)
    if state != 'ready':
        raise HTTPException(503, {'code':state,'message':'影像存储需完成经审查的结构升级与历史数据转换。'})


def read_imaging_history(db,patient_id):
    state = imaging_history_status(db,patient_id)
    if state != 'ready':
        return None,None,state
    image = db.scalar(select(ImagingVisualization).where(ImagingVisualization.patient_id == patient_id).order_by(ImagingVisualization.created_at.desc(),ImagingVisualization.id.desc()).limit(1))
    prediction = db.scalar(select(ModelPrediction).where(ModelPrediction.patient_id == patient_id).order_by(ModelPrediction.created_at.desc(),ModelPrediction.id.desc()).limit(1))
    return image,prediction,'ready' if image is not None or prediction is not None else 'no_records'


def stamp_storage_context(db,row,actor,*,input_context):
    previous=row.storage_context
    migrated=getattr(row,'envelope_status',None) == 'migrated_from_legacy'
    content={field:getattr(row,field) for field in row.record_fields if field != 'storage_context'}
    saved_digest=hashlib.sha256(json.dumps(content,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()
    row.storage_context = {
        'context_version':1,'actor_user_id':actor.id,
        'authority_receipts': [list(receipt) for receipt in db.info.get('authorization_receipts',[])],
        'saved_at':datetime.now(timezone.utc).isoformat(timespec='microseconds'),
        'source_binding_status':'authenticated_api_write',
        'source_binding_retroactively_proven':False if migrated else None,
        'professional_review_status':'not_recorded',
        'input':input_context, 'saved_content_sha256':saved_digest, 'metadata':canonical_metadata(row),
        **({'conversion_source_digest':previous.get('conversion_source_digest')} if migrated else {}),
    }


def append_storage_audit(db,row,actor,action):
    from backend.app.services.security_service import _append_audit_log
    is_result=hasattr(row,'record_object_type')
    context=row.storage_context if is_result else {'sha256':row.file_hash,'status':row.status,'note':row.note}
    digest=hashlib.sha256(json.dumps(context,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
    return _append_audit_log(db,action=action,status='success',message='影像存储与实际保存人、输入上下文的关键事务证据。',
        actor_user_id=actor.id,patient_id=row.patient_id,
        detail_json={'object_type':row.record_object_type if is_result else 'upload','object_id':row.id,
            'data_version':row.data_version if is_result else None,'storage_context_sha256':digest})


def commit_storage_transaction(db):
    db.commit()


def save_storage_transaction(db,row,actor,*,action):
    try:
        db.flush()
        if isinstance(row,ModelPrediction):
            from backend.app.services.imaging_report_service import generate
            generate(db,row,actor)
        append_storage_audit(db,row,actor,action)
        recheck_request_authority(db)
        commit_storage_transaction(db)
    except Exception as exc:
        db.rollback()
        if isinstance(exc,HTTPException):
            raise
        raise HTTPException(503,'影像保存事务未完成，请重新查询后重试。') from exc
    from backend.app.services.event_service import mark_transaction_audit_committed
    mark_transaction_audit_committed(db)
