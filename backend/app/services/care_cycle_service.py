"""Self-cycle business transactions. Never commits, rolls back or publishes externally.

Caller must commit facts, events and critical audit together, then mark the audit
committed before returning data. Existing request authority checks still apply.
Dates use the cycle's fixed Asia/Shanghai calendar; actual submissions use UTC.
Old TrackingLog/day_index data is never read or assigned invented dates here.
"""
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.care_cycle import CareCycle, DailyRecord
from backend.app.schemas.care_cycle import CareCycleCreate, DailyRecordCreate
from backend.app.services.assessment_service import authorization_snapshot
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.event_service import append_care_event
from backend.app.services.identity_access import identity_basis, require_processing_access, require_patient_access, self_access, recheck_receipts

CALENDAR = "Asia/Shanghai"
_CYCLE_CONTEXT = ("id","client_cycle_id","patient_id","cycle_type","start_date","end_date","calendar_timezone",
    "actor_user_id","actor_identity_basis","authorization_snapshot","responsible_doctor_id","plan_version_id","created_at")
_DAILY_CONTEXT = ("id","client_submission_id","patient_id","cycle_id","record_date","revision","expected_revision",
    "actor_user_id","actor_identity_basis","authorization_snapshot","content_digest","recorded_at","submitted_at")


def _utc(value):
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def _context(row, fields):
    def plain(value):
        if isinstance(value,datetime):
            return _utc(value).isoformat()
        if isinstance(value,date):
            return value.isoformat()
        return value
    return {key:plain(getattr(row,key)) for key in fields}


def _verify(row):
    fields = _CYCLE_CONTEXT if isinstance(row,CareCycle) else _DAILY_CONTEXT
    if row.snapshot != _context(row,fields):
        raise RecordIntegrityError("Cycle/daily metadata or original authorization differs from authenticated snapshot.")
    if isinstance(row,DailyRecord) and canonical_digest(_semantic(row,row.content)) != row.content_digest:
        raise RecordIntegrityError("Daily record content differs from its authenticated digest.")


def _own(db,user,patient_id,*,processing):
    db.info["requires_basic_use"] = processing
    if not self_access(db,user.id,patient_id):
        raise HTTPException(403,"Only the actual self user or current verified guardian may use self cycles.")
    return (require_processing_access if processing else require_patient_access)(db,user,patient_id,"tracking")


def _original(db,snapshot):
    receipts = [(actor,patient,tuple(scope),purpose,tuple(tuple(version) for version in versions))
        for actor,patient,scope,purpose,versions in snapshot]
    previous = list(db.info.get("authorization_receipts",[]))
    previous_processing = db.info.get("requires_basic_use",False)
    try:
        recheck_receipts(db,receipts)
    finally:
        current = db.info.get("authorization_receipts",[])
        db.info["authorization_receipts"] = previous+[receipt for receipt in current if receipt not in previous]
        db.info["requires_basic_use"] = previous_processing
        request = db.info.get("authorization_request")
        if request is not None:
            request.state.authorization_receipts = db.info["authorization_receipts"]


def _audit(db,user,patient_id,action,**detail):
    from backend.app.services.deferred_read_audit import append_read_audit
    try:
        append_read_audit(db,failure_detail="Critical care-cycle audit is unavailable; retry the original submission ID.",action=action,status="success",message="真实日期周期事务证据。",
            patient_id=patient_id,actor_user_id=user.id,detail_json=detail)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503,"Critical care-cycle audit is unavailable; retry the original submission ID.") from exc


def _load_cycle(db,cycle_id):
    row = db.get(CareCycle,cycle_id,populate_existing=True)
    if row is None:
        raise HTTPException(404,"Care cycle not found.")
    _verify(row)
    return row


def _cycle_response(row):
    return {**_context(row,_CYCLE_CONTEXT),"total_days":(row.end_date-row.start_date).days+1,
        "professional_plan_status":"doctor_published" if row.cycle_type == 'professional' else "not_applicable_self", "status":row.cycle_type}


def _cycle_access(db, user, row, *, processing=False, record_date=None):
    if row.cycle_type == 'professional':
        from backend.app.services.care_plan_service import authorize_cycle
        return authorize_cycle(db, user, row, processing=processing, record_date=record_date)
    _own(db, user, row.patient_id, processing=processing)
    if processing and _self_reviewed(db, row):
        raise HTTPException(409, 'This self cycle was explicitly closed; use its actual next cycle and retain the original history.')


def _self_reviewed(db, row):
    if row.cycle_type != 'self':
        return False
    from sqlalchemy import inspect
    if not inspect(db.connection()).has_table('cycle_reviews'):
        return False
    from backend.app.models.review import CycleReview
    review = db.scalar(select(CycleReview).where(CycleReview.cycle_id == row.id,CycleReview.patient_id == row.patient_id).order_by(CycleReview.version.desc()))
    return review is not None


def _availability(db,user,row):
    """Probe original write authority without making historical reads processing."""
    if row.cycle_type == 'professional':
        from backend.app.services.care_plan_service import _load, _availability as plan_available
        from backend.app.models.care_plan import PlanVersion
        version = db.get(PlanVersion, row.plan_version_id)
        plan = _load(db, version.plan_id)
        active = plan_available(db, user, plan)
        return {'processing_status': 'active' if active else plan.status, 'suspension_reason': plan.suspension_reason,
            'allowed_actions': ['create_daily'] if active and self_access(db, user.id, row.patient_id) and row.start_date <= datetime.now(timezone.utc).astimezone(ZoneInfo(row.calendar_timezone)).date() else []}
    previous = list(db.info.get("authorization_receipts",[]))
    previous_processing = db.info.get("requires_basic_use",False)
    request = db.info.get("authorization_request")
    try:
        if row.actor_user_id != user.id:
            return {"processing_status":"suspended","suspension_reason":"original_actor_changed","allowed_actions":[]}
        try:
            _own(db,user,row.patient_id,processing=True)
            _original(db,row.authorization_snapshot)
        except HTTPException as exc:
            if exc.status_code not in {403,409}:
                raise
            return {"processing_status":"suspended","suspension_reason":
                "original_authorization_replaced" if exc.status_code == 409 else "original_authorization_unavailable", "allowed_actions":[]}
        today = datetime.now(timezone.utc).astimezone(ZoneInfo(row.calendar_timezone)).date()
        if _self_reviewed(db, row):
            return {'processing_status':'ended','suspension_reason':None,'allowed_actions':[]}
        return {"processing_status":"active","suspension_reason":None,
            "allowed_actions":["create_daily"] if row.start_date <= today else []}
    finally:
        db.info["requires_basic_use"] = previous_processing
        db.info["authorization_receipts"] = previous
        if request is not None:
            request.state.authorization_receipts = previous


def create_cycle(db,user,payload):
    payload = CareCycleCreate.model_validate(payload)
    existing = db.scalar(select(CareCycle).where(CareCycle.client_cycle_id == payload.client_cycle_id))
    if existing is not None:
        _verify(existing)
        if (existing.patient_id,existing.actor_user_id,existing.start_date,existing.end_date,existing.cycle_type) != (
            payload.patient_id,user.id,payload.start_date,payload.end_date,payload.cycle_type):
            raise HTTPException(409,"This client cycle ID belongs to different immutable content or actor.")
        _own(db,user,payload.patient_id,processing=True)
        _original(db,existing.authorization_snapshot)
        _audit(db,user,payload.patient_id,"care_cycle_retry_ack",cycle_id=existing.id)
        return _cycle_response(existing)
    _own(db,user,payload.patient_id,processing=True)
    if payload.cycle_type != "self":
        raise HTTPException(409,"Professional cycles require a real doctor-approved W06 plan version; not yet available.")
    row = CareCycle(**payload.model_dump(),calendar_timezone=CALENDAR,actor_user_id=user.id,
        actor_identity_basis=identity_basis(db,user.id,payload.patient_id),authorization_snapshot=authorization_snapshot(db),
        responsible_doctor_id=None,plan_version_id=None,created_at=datetime.now(timezone.utc),snapshot={})
    db.add(row)
    try:
        db.flush()
        # Seal the primary-key-bound metadata as part of the insert transaction.
        from backend.app.core.record_envelope import seal_record
        from sqlalchemy.orm.attributes import set_committed_value
        cipher = seal_record(_context(row,_CYCLE_CONTEXT),row._binding("snapshot"))
        db.execute(update(CareCycle).where(CareCycle.id == row.id).values(_snapshot_cipher=cipher).execution_options(synchronize_session=False))
        set_committed_value(row,"_snapshot_cipher",cipher)
        append_care_event(db,patient_id=row.patient_id,actor_user_id=user.id,event_type="self_cycle_created",
            aggregate_type="care_cycle",aggregate_id=row.id,revision=1,payload={"cycle_id":row.id,"cycle_type":"self",
                "start_date":row.start_date.isoformat(),"end_date":row.end_date.isoformat(),"authorization_snapshot":row.authorization_snapshot},
            dedupe_key="self_cycle:"+row.client_cycle_id,actor_identity_basis=row.actor_identity_basis)
        _audit(db,user,row.patient_id,"self_cycle_created",cycle_id=row.id)
    except IntegrityError as exc:
        raise HTTPException(409,"Concurrent cycle creation requires an unchanged retry.") from exc
    return _cycle_response(row)


def _semantic(row,content):
    return {"patient_id":row.patient_id,"cycle_id":row.cycle_id,"record_date":row.record_date.isoformat(),
        "client_submission_id":row.client_submission_id,"expected_revision":row.expected_revision,
        "recorded_at":_utc(row.recorded_at).isoformat() if row.recorded_at else None,"content":content}


def _ack(row):
    _verify(row)
    local_submission = _utc(row.submitted_at).astimezone(ZoneInfo(CALENDAR)).date()
    return {"record_id":row.id,**{key:value for key,value in _context(row,_DAILY_CONTEXT).items() if key != "id"},
        "recorded_at_status":"reported" if row.recorded_at else "unknown","is_backfill":row.record_date < local_submission,
        "content":row.content,"legacy":False,"submission_status":"committed"}


def submit_daily_record(db,user,payload):
    payload = DailyRecordCreate.model_validate(payload)
    content = payload.content.model_dump()
    digest = canonical_digest(_semantic(payload,content))
    existing = db.scalar(select(DailyRecord).where(DailyRecord.client_submission_id == payload.client_submission_id).execution_options(populate_existing=True))
    if existing is not None:
        _verify(existing)
        if existing.actor_user_id != user.id or existing.content_digest != digest:
            raise HTTPException(409,"This submission ID belongs to a different original actor or body.")
        _own(db,user,payload.patient_id,processing=True)
        _original(db,existing.authorization_snapshot)
        cycle = _load_cycle(db,payload.cycle_id)
        _original(db,cycle.authorization_snapshot)
        _audit(db,user,payload.patient_id,"daily_record_retry_ack",record_id=existing.id,content_digest=digest)
        return _ack(existing),False
    _own(db,user,payload.patient_id,processing=True)
    # Serialize revisions on the real aggregate, including SQLite's write lock.
    db.execute(update(CareCycle).where(CareCycle.id == payload.cycle_id).values(id=CareCycle.id))
    cycle = _load_cycle(db,payload.cycle_id)
    if cycle.patient_id != payload.patient_id:
        raise HTTPException(409,"The daily record patient differs from the immutable cycle patient.")
    if cycle.cycle_type == 'self' and cycle.actor_user_id != user.id:
        raise HTTPException(403,"Only the original cycle actor can add observations to this cycle.")
    _cycle_access(db, user, cycle, processing=True, record_date=payload.record_date)
    _original(db,cycle.authorization_snapshot)
    now = datetime.now(timezone.utc)
    today = now.astimezone(ZoneInfo(cycle.calendar_timezone)).date()
    if not cycle.start_date <= payload.record_date <= cycle.end_date or payload.record_date > today:
        raise HTTPException(422,"Daily record date must be a real elapsed date within this cycle.")
    if payload.recorded_at is not None and _utc(payload.recorded_at) > now:
        raise HTTPException(422,"The reported original record time cannot be in the future.")
    latest = db.scalar(select(func.max(DailyRecord.revision)).where(DailyRecord.cycle_id == cycle.id,DailyRecord.record_date == payload.record_date)) or 0
    if latest != payload.expected_revision:
        raise HTTPException(409,"Daily revision changed; refresh and explicitly revise the existing day.")
    row = DailyRecord(patient_id=cycle.patient_id,cycle_id=cycle.id,record_date=payload.record_date,
        client_submission_id=payload.client_submission_id,expected_revision=payload.expected_revision,revision=latest+1,
        actor_user_id=user.id,actor_identity_basis=identity_basis(db,user.id,cycle.patient_id),authorization_snapshot=authorization_snapshot(db),
        content_digest=digest,recorded_at=payload.recorded_at,submitted_at=now,content=content,snapshot={})
    db.add(row)
    try:
        db.flush()
        from backend.app.core.record_envelope import seal_record
        from sqlalchemy.orm.attributes import set_committed_value
        cipher = seal_record(_context(row,_DAILY_CONTEXT),row._binding("snapshot"))
        db.execute(update(DailyRecord).where(DailyRecord.id == row.id).values(_snapshot_cipher=cipher).execution_options(synchronize_session=False))
        set_committed_value(row,"_snapshot_cipher",cipher)
        append_care_event(db,patient_id=row.patient_id,actor_user_id=user.id,event_type="daily_record_submitted",
            aggregate_type="daily_record",aggregate_id=row.id,revision=row.revision,
            payload={"record_id":row.id,"cycle_id":cycle.id,"record_date":row.record_date.isoformat(),"revision":row.revision,
                "content_digest":digest,"authorization_snapshot":row.authorization_snapshot},dedupe_key="daily_record:"+row.client_submission_id,
            actor_identity_basis=row.actor_identity_basis)
        _audit(db,user,row.patient_id,"daily_record_submitted",record_id=row.id,cycle_id=cycle.id,content_digest=digest,revision=row.revision)
    except IntegrityError as exc:
        raise HTTPException(409,"Concurrent daily submission requires an unchanged retry after refresh.") from exc
    return _ack(row),True


def get_daily_record(db,user,client_submission_id):
    row = db.scalar(select(DailyRecord).where(DailyRecord.client_submission_id == client_submission_id))
    if row is None:
        raise HTTPException(404,"Daily submission not found.")
    _verify(row)
    if row.actor_user_id != user.id:
        raise HTTPException(403,"Only the original submitting actor can recover the original ACK.")
    cycle = _load_cycle(db,row.cycle_id)
    if cycle.cycle_type == 'professional':
        _cycle_access(db,user,cycle)
    else:
        _own(db,user,row.patient_id,processing=True)
        _original(db,row.authorization_snapshot)
        _original(db,cycle.authorization_snapshot)
    _audit(db,user,row.patient_id,"daily_record_ack_read",record_id=row.id)
    return _ack(row)


def _cycle_records(db,row):
    records = db.scalars(select(DailyRecord).where(DailyRecord.cycle_id == row.id,DailyRecord.patient_id == row.patient_id)
        .order_by(DailyRecord.record_date,DailyRecord.revision)).all()
    for record in records:
        _verify(record)
    return records


def get_cycle(db,user,cycle_id):
    row = _load_cycle(db,cycle_id)
    _cycle_access(db,user,row)
    records = _cycle_records(db,row)
    latest = {record.record_date:record for record in records}
    today = datetime.now(timezone.utc).astimezone(ZoneInfo(row.calendar_timezone)).date()
    due_dates = [row.start_date+timedelta(days=offset) for offset in range(max(0,(min(today,row.end_date)-row.start_date).days+1))]
    completed = [day for day in due_dates if day in latest]
    missing = [day for day in due_dates if day not in latest]
    _audit(db,user,row.patient_id,"care_cycle_read",cycle_id=row.id)
    return {**_cycle_response(row),**_availability(db,user,row),"as_of_date":today.isoformat(),
        "summary":{"as_of_date":today.isoformat(),"due_count":len(due_dates),
        "completed_count":len(completed),"completed_dates":[day.isoformat() for day in completed],
        "missing_dates":[day.isoformat() for day in missing],"coverage":len(completed)/len(due_dates) if due_dates else None},
        "records":[_ack(record) for record in latest.values()]}


def list_cycles(db,user,patient_id):
    require_patient_access(db,user,patient_id,'tracking')
    query = select(CareCycle).where(CareCycle.patient_id == patient_id)
    if not self_access(db,user.id,patient_id):
        query = query.where(CareCycle.cycle_type == 'professional', CareCycle.responsible_doctor_id == user.id)
    rows = db.scalars(query.order_by(CareCycle.start_date,CareCycle.id)).all()
    for row in rows:
        _verify(row)
        _cycle_access(db,user,row)
    _audit(db,user,patient_id,"care_cycles_read",cycle_ids=[row.id for row in rows])
    return {"items":[{**_cycle_response(row),**_availability(db,user,row)} for row in rows],
        "as_of_date":datetime.now(timezone.utc).astimezone(ZoneInfo(CALENDAR)).date().isoformat(),"calendar_timezone":CALENDAR}


def daily_history(db,user,cycle_id,record_date):
    row = _load_cycle(db,cycle_id)
    _cycle_access(db,user,row)
    if isinstance(record_date,str):
        record_date = date.fromisoformat(record_date)
    if not row.start_date <= record_date <= row.end_date:
        raise HTTPException(422,"History date is outside this real cycle.")
    records = [record for record in _cycle_records(db,row) if record.record_date == record_date]
    _audit(db,user,row.patient_id,"daily_history_read",cycle_id=row.id,record_date=record_date.isoformat())
    return {"items":[_ack(record) for record in records]}
