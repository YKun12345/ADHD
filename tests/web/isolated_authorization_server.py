"""W02 actual API/page verification with synthetic institutional provisioning only."""
import os
import tempfile
from pathlib import Path

from isolated_server import runtime, root

authority_runtime = Path(tempfile.mkdtemp(prefix='w02-independent-authority-', dir=root / '.codex-tmp'))
os.environ['AUTHORIZATION_LEDGER_PATH'] = str(authority_runtime / 'authorization-heads.db')

if __name__ == '__main__':
    import sys
    import uvicorn
    from fastapi import Header, HTTPException
    from pydantic import BaseModel, Field
    from backend.app.main import app
    from backend.tests.w02_helpers import qualify

    assert os.environ['APP_ENV'] == 'test'

    class SyntheticAuthority(BaseModel):
        user_id: int = Field(gt=0)
        reviewer: bool = False

    @app.post('/api/v1/__synthetic__/authority')
    def provision(payload: SyntheticAuthority, x_synthetic_test: str = Header(default='')):
        if x_synthetic_test != 'w02-local-synthetic-fixture-only':
            raise HTTPException(403, 'Synthetic fixture access only')
        qualify(payload.user_id, reviewer=payload.reviewer)
        return {'synthetic_fixture': True, 'user_id': payload.user_id}

    @app.post('/api/v1/__synthetic__/assign-guardian/{guardian_id}')
    def assign(guardian_id: int, x_synthetic_test: str = Header(default='')):
        if x_synthetic_test != 'w02-local-synthetic-fixture-only':
            raise HTTPException(403, 'Synthetic fixture access only')
        from backend.app.db.session import SessionLocal
        from backend.app.models.identity import GuardianRelationship
        with SessionLocal() as db:
            row = db.get(GuardianRelationship, guardian_id)
            if not row: raise HTTPException(404, 'Unknown synthetic guardian')
            row.institution_id = 'synthetic-institution'
            db.commit()
        return {'synthetic_fixture': True, 'guardian_id': guardian_id}

    @app.post('/api/v1/__synthetic__/expire-doctor/{user_id}')
    def expire_doctor(user_id: int, x_synthetic_test: str = Header(default='')):
        if x_synthetic_test != 'w02-local-synthetic-fixture-only':
            raise HTTPException(403, 'Synthetic fixture access only')
        from datetime import datetime, timedelta, timezone
        from sqlalchemy import select
        from backend.app.db.session import SessionLocal
        from backend.app.models.identity import DoctorQualification
        with SessionLocal() as db:
            row = db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == user_id))
            if row is None:
                raise HTTPException(404, 'Unknown synthetic qualification')
            row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            db.commit()
        return {'synthetic_fixture': True, 'expired_user_id': user_id}

    @app.post('/api/v1/__synthetic__/observe-deadline/{attention_id}')
    def observe_deadline(attention_id: int, x_synthetic_test: str = Header(default='')):
        if x_synthetic_test != 'w02-local-synthetic-fixture-only':
            raise HTTPException(403, 'Synthetic fixture access only')
        from datetime import timedelta, timezone
        from backend.app.db.session import SessionLocal
        from backend.app.models.attention import AttentionItem
        from backend.app.services.attention_deadline_service import monitor_once
        with SessionLocal() as db:
            row = db.get(AttentionItem, attention_id)
            if row is None or row.expected_response_at is None:
                raise HTTPException(404, 'No actual synthetic response deadline')
            deadline = row.expected_response_at
            observed = (deadline if deadline.tzinfo else deadline.replace(tzinfo=timezone.utc)) + timedelta(seconds=1)
        saved = monitor_once(SessionLocal, clock=lambda: observed)
        return {'synthetic_fixture': True, 'explicit_synthetic_monitor_clock': True,
            'observed_at': observed.isoformat(), 'actual_records_saved': saved}

    uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[1]), log_level='warning')
