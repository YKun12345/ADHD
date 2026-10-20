"""External provider calls need current, explicit scoped consent at dispatch time."""
from contextlib import contextmanager
from contextvars import ContextVar
from fastapi import HTTPException

_authorization = ContextVar("external_provider_authorization", default=None)


def provider_allowed():
    callback = _authorization.get()
    if callback is None:
        return False
    try:
        return bool(callback())
    except HTTPException:
        return False


@contextmanager
def authorize_external_ai(db, user, patient_id, scope):
    from backend.app.db.session import SessionLocal
    from backend.app.services.consent_service import has_consent, current_consent
    from backend.app.services.identity_access import self_access
    with SessionLocal() as initial_db:
        initial_access = self_access(initial_db,user.id,patient_id)
        initial_basic = current_consent(initial_db,patient_id,"basic_use")
        initial_external = current_consent(initial_db,patient_id,"external_ai")
        initial_versions = tuple((row.id,row.ledger_key,row.revision) if row else None for row in (initial_access,initial_basic,initial_external))
    def check():
        with SessionLocal() as authority_db:
            access = self_access(authority_db,user.id,patient_id)
            basic = current_consent(authority_db,patient_id,"basic_use")
            external = current_consent(authority_db,patient_id,"external_ai")
            versions = tuple((row.id,row.ledger_key,row.revision) if row else None for row in (access,basic,external))
            return bool(versions == initial_versions and access and has_consent(authority_db,patient_id,"basic_use",scope=scope) and has_consent(authority_db,patient_id,"external_ai",scope=scope))
    token = _authorization.set(check)
    try:
        yield check()
    finally:
        _authorization.reset(token)


def minimized_snapshot(snapshot):
    profile = snapshot.get("patient_profile") or {}
    scale = snapshot.get("latest_scale") or {}
    cognitive = snapshot.get("cognitive_profile") or {}
    tracking = snapshot.get("tracking") or {}
    age = profile.get("age")
    return {"patient_profile":{"patient_type":profile.get("patient_type"),"age_band":"child" if isinstance(age,int) and age < 18 else "adult"},"latest_scale":{key:scale[key] for key in ("scale_type","total_score","risk_level","sub_scores","radar_scores") if key in scale},"cognitive_profile":{key:cognitive[key] for key in ("test_count","average_accuracy","average_reaction_time","overall_score") if key in cognitive},"tracking":{key:tracking[key] for key in ("total_days","completed_count","current_day","completion_status","average_mood","average_focus_minutes","consecutive_missed_days") if key in tracking},"latest_imaging_visualization":None,"latest_model_prediction":None}
