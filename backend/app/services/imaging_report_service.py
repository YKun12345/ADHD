from datetime import datetime,timezone
from fastapi import HTTPException
from sqlalchemy import select,update,inspect
from backend.app.models.imaging_report import ImagingReportVersion
from backend.app.models.model_prediction import ModelPrediction
from backend.app.models.review import metadata
from backend.app.schemas.imaging_report import ImagingReportPublish
from backend.app.services import review_service as reviews
from backend.app.services import assessment_service as assessments
from backend.app.services import care_plan_service as plans
from backend.app.services.identity_access import require_patient_access,require_processing_access,require_doctor,self_access
from backend.app.services.attention_action_service import _original,_historical_original
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.imaging_storage_service import require_imaging_storage


def _schema(db):
    if 'imaging_report_versions' not in inspect(db.connection()).get_table_names():
        raise HTTPException(503,'影像报告版本结构尚未经过授权升级。')


def _source(db,user,pid,prediction_id):
    require_patient_access(db,user,pid,'imaging');require_imaging_storage(db,pid)
    row=db.get(ModelPrediction,prediction_id,populate_existing=True)
    if row is None:raise HTTPException(404,'影像分析原件不存在。')
    if row.patient_id!=pid:raise HTTPException(403,'影像分析原件属于另一个档案。')
    context=row.storage_context
    return row,{'patient_id':pid,'prediction_id':row.id,'data_version':row.data_version,'source_type':row.source_type,
        'model_name':row.model_name,'model_version':row.model_version,'roi_dim_used':row.roi_dim_used,'timepoints':row.timepoints,
        'prediction_label':row.prediction_label,'probability':row.probability,'probability_control':row.probability_control,
        'summary_text':row.summary_text,'storage_context':context,'demonstration_only':row.source_type=='mock'}


def _ack(row):return {'id':row.id,**row.snapshot['ack'],'submission_status':'committed','legacy':False}


def _append(db,source,actor,payload,publisher,body,limitations,previous,authority,credentials):
    now=datetime.now(timezone.utc).replace(microsecond=0)
    row=ImagingReportVersion(patient_id=source['patient_id'],prediction_id=source['prediction_id'],actor_user_id=actor.id,
        client_publication_id=payload['client_publication_id'],version=previous+1,publisher_kind=publisher,
        input_digest=canonical_digest(source),payload_digest=canonical_digest(payload),published_at=now)
    ack={'patient_id':row.patient_id,'prediction_id':row.prediction_id,'client_publication_id':row.client_publication_id,
        'version':row.version,'actor_user_id':actor.id,'publisher_kind':publisher,'professional_review_status':'reviewed' if publisher=='doctor' else 'not_reviewed',
        'status':'published','body':body,'limitations':limitations,'input_digest':row.input_digest,'payload_digest':row.payload_digest,
        'published_at':reviews._utc(now),'demonstration_only':source['demonstration_only'],
        'source':{**{key:source[key] for key in ('prediction_id','source_type','model_name','model_version','roi_dim_used','timepoints')},
            'source_admission_status':source['storage_context'].get('input',{}).get('model_registration_status','not_recorded'),
            'model_artifact_sha256':source['storage_context'].get('input',{}).get('model_artifact_sha256')},
        'purpose':'demonstration_only' if source['demonstration_only'] else 'screening_support',
        'raw_image_session_included':False,'original_request':payload}
    ack['publication_context_digest']=canonical_digest(reviews._decode(payload['publication_context'],'imaging-report-publication')) if publisher=='doctor' else None
    ack['authorization_snapshot']=authority
    ack['confirmed']=publisher=='doctor' and payload.get('confirmed') is True
    row.snapshot={'metadata':metadata(row),'input':source,'payload':payload,'ack':ack,
        'authorization_snapshot':authority,'credential_snapshot':credentials}
    db.add(row);db.flush();reviews._audit(db,actor,row.patient_id,'imaging_report_published',{'report_id':row.id,
        'prediction_id':row.prediction_id,'version':row.version,'publisher_kind':publisher,'input_digest':row.input_digest})
    from backend.app.services.event_service import append_care_event
    append_care_event(db,patient_id=row.patient_id,actor_user_id=actor.id,event_type='imaging_report_published',
        aggregate_type='imaging_report_version',aggregate_id=row.id,revision=row.version,
        payload={'report_id':row.id,'prediction_id':row.prediction_id,'version':row.version},
        dedupe_key='imaging_report:'+row.client_publication_id,actor_identity_basis=f'actor:{actor.id}:imaging')
    return _ack(row)


def generate(db,prediction,actor):
    """Called within the original analysis transaction, without a fictional doctor."""
    _schema(db)
    old=db.scalar(select(ImagingReportVersion).where(ImagingReportVersion.prediction_id==prediction.id))
    if old:return _ack(old)
    _,source=_source(db,actor,prediction.patient_id,prediction.id)
    legacy = False
    if not source['demonstration_only']:
        context=source['storage_context'].get('input',{})
        if context.get('model_registration_status') == 'legacy_accepted':
            from backend.app.services.model_admission_service import inspect_hgst_admission
            current=inspect_hgst_admission()
            legacy=(current['status']=='legacy_accepted' and current['real_inference_allowed']
                and context.get('model_artifact_sha256')==current['artifact']['sha256'])
            if not legacy:raise HTTPException(409,'原权重兼容状态或权重身份已变化，不能形成新报告。')
        elif not context.get('model_version_id') or context.get('model_input_contract_status')!='verified':
            raise HTTPException(409,'真实分析缺少经过准入的模型版本或输入契约，不能形成新报告。')
    payload={'client_publication_id':f'imaging-system-{prediction.id}','patient_id':prediction.patient_id,'prediction_id':prediction.id,
        'system_generated':True,'input_digest':canonical_digest(source)}
    return _append(db,source,actor,payload,'system',source['summary_text'] or '本次影像分析已生成，请结合来源和局限核对。',
        '演示输出，不是真实模型分析或诊断。' if source['demonstration_only'] else
        ('沿用原有旧权重，训练来源和输入一致性未重新核验；尚未经过医生专业审核，不能代替诊断。' if legacy else
         '筛查辅助结果，尚未经过医生专业审核，不能代替诊断。'),
        0,assessments.authorization_snapshot(db),[])


def _read(db,user,row):
    db.info['requires_basic_use']=False
    require_patient_access(db,user,row.patient_id,'imaging')
    if not self_access(db,user.id,row.patient_id):
        require_doctor(db,user.id);_historical_original(db,row.snapshot['authorization_snapshot'])


@reviews.storage_boundary
def listing(db,user,pid):
    require_patient_access(db,user,pid,'imaging');_schema(db)
    rows=db.scalars(select(ImagingReportVersion).where(ImagingReportVersion.patient_id==pid).order_by(ImagingReportVersion.id.desc())).all()
    items=[]
    for row in rows:_read(db,user,row);items.append(_ack(row))
    reviews._audit(db,user,pid,'data_read',{'scope':'imaging_report_versions','ids':[row.id for row in rows]})
    return {'patient_id':pid,'items':items}


@reviews.storage_boundary
def detail(db,user,identifier):
    _schema(db)
    # Scope-check the scalar reference before any sensitive snapshot decrypt.
    pid=db.scalar(select(ImagingReportVersion.patient_id).where(ImagingReportVersion.id==identifier))
    if pid is None:raise HTTPException(404,'影像报告版本不存在。')
    require_patient_access(db,user,pid,'imaging')
    row=db.get(ImagingReportVersion,identifier,populate_existing=True);_read(db,user,row)
    reviews._audit(db,user,pid,'data_read',{'scope':'imaging_report_version','report_id':identifier})
    return _ack(row)


@reviews.storage_boundary
def prepare(db,user,pid,prediction_id):
    require_doctor(db,user.id);require_processing_access(db,user,pid,'imaging');_schema(db)
    if self_access(db,user.id,pid):raise HTTPException(403,'请由具有实际临床共享关系的医生审核。')
    _,source=_source(db,user,pid,prediction_id)
    previous=db.scalar(select(ImagingReportVersion.version).where(ImagingReportVersion.prediction_id==prediction_id).order_by(ImagingReportVersion.version.desc()).limit(1))
    if not previous:raise HTTPException(409,'请先生成实际影像分析报告。')
    context={'purpose':'imaging_report_publication','context_version':1,'patient_id':pid,'prediction_id':prediction_id,'actor_user_id':user.id,'expected_previous_version':previous,
        'input_digest':canonical_digest(source),'authorization_snapshot':assessments.authorization_snapshot(db),'credential_snapshot':plans._credentials(db)}
    reviews._audit(db,user,pid,'data_read',{'scope':'imaging_report_review_preflight','prediction_id':prediction_id})
    return {**context,'publication_context':reviews._encode(context,'imaging-report-publication'),'publication_context_digest':canonical_digest(context),'source':source}


@reviews.storage_boundary
def publish(db,user,payload):
    payload=reviews._validate(ImagingReportPublish,payload);values=payload.model_dump()
    if not payload.confirmed or not payload.body.strip() or not payload.limitations.strip():raise HTTPException(422,'请明确核对正文和局限后确认发布。')
    require_doctor(db,user.id);require_processing_access(db,user,payload.patient_id,'imaging');_schema(db)
    if self_access(db,user.id,payload.patient_id):raise HTTPException(403,'本人记录不能代替临床医生审核。')
    ctx=reviews._decode(payload.publication_context,'imaging-report-publication')
    for name,value in [('patient_id',payload.patient_id),('prediction_id',payload.prediction_id),('actor_user_id',user.id),('expected_previous_version',payload.expected_previous_version),('input_digest',payload.input_digest)]:
        if ctx.get(name)!=value:raise HTTPException(409,'发布与原医生、来源或版本不一致。')
    _original(db,ctx['authorization_snapshot']);plans._original_credentials(db,ctx['credential_snapshot'])
    existing=db.scalar(select(ImagingReportVersion).where(ImagingReportVersion.client_publication_id==payload.client_publication_id))
    if existing:
        if existing.actor_user_id!=user.id or existing.payload_digest!=canonical_digest(values):raise HTTPException(409,'该原编号已有其他发布内容。')
        return _ack(existing),False
    db.execute(update(ModelPrediction).where(ModelPrediction.id==payload.prediction_id).values(id=ModelPrediction.id))
    _,source=_source(db,user,payload.patient_id,payload.prediction_id)
    latest=db.scalar(select(ImagingReportVersion.version).where(ImagingReportVersion.prediction_id==payload.prediction_id).order_by(ImagingReportVersion.version.desc()).limit(1).with_for_update())
    if latest!=payload.expected_previous_version or canonical_digest(source)!=payload.input_digest:raise HTTPException(409,'影像原件或报告版本已变化，请重新核对。')
    return _append(db,source,user,values,'doctor',payload.body,payload.limitations,latest,ctx['authorization_snapshot'],ctx['credential_snapshot']),True


@reviews.storage_boundary
def original(db,user,client_id):
    _schema(db)
    ref=db.execute(select(ImagingReportVersion.id,ImagingReportVersion.patient_id,ImagingReportVersion.actor_user_id).where(ImagingReportVersion.client_publication_id==client_id)).first()
    if ref is None:raise HTTPException(404,'原影像报告发布尚未保存。')
    if ref.actor_user_id!=user.id:raise HTTPException(403,'仅原实际发布者可以恢复该发布确认。')
    return detail(db,user,ref.id)
