"""Synthetic TCP fixture; all destructive schema cases are confined to its own temp DB."""
import os
from pathlib import Path
from isolated_server import runtime, root

os.environ['AUTHORIZATION_LEDGER_PATH'] = str(runtime / 'storage-authorization-heads.db')

if __name__ == '__main__':
    import sys
    import uvicorn
    from fastapi import Header, HTTPException
    from pydantic import BaseModel, Field
    from sqlalchemy import text
    from backend.app.main import app
    from backend.app.db.session import engine
    from backend.tests.w02_helpers import qualify
    from backend.app.core.data_encryption import encrypt_value

    assert os.environ['APP_ENV'] == 'test'
    assert Path(engine.url.database).resolve().is_relative_to(runtime.resolve())

    class Fixture(BaseModel):
        user_id: int | None = Field(default=None, gt=0)
        patient_id: int | None = Field(default=None, gt=0)
        mode: str = ''

    @app.post('/api/v1/__synthetic__/storage-fixture')
    def prepare(payload: Fixture, x_synthetic_test: str = Header(default='')):
        if x_synthetic_test != 'w09-local-synthetic-storage-only':
            raise HTTPException(403, 'Synthetic fixture access only')
        if payload.mode == 'qualify' and payload.user_id:
            qualify(payload.user_id)
        elif payload.mode == 'legacy' and payload.patient_id:
            values = {'patient_id': payload.patient_id,
                'file_name': encrypt_value('synthetic-unconverted-private.csv', 'model_predictions.file_name'),
                'prediction_label': encrypt_value('Control', 'model_predictions.prediction_label'),
                'probability': encrypt_value(.2, 'model_predictions.probability')}
            with engine.begin() as conn:
                conn.execute(text("INSERT INTO model_predictions(patient_id,file_name,prediction_label,probability,source_type,created_at) "
                    "VALUES(:patient_id,:file_name,:prediction_label,:probability,'fmri_hgst','2026-01-01 00:00:00')"), values)
        elif payload.mode == 'missing':
            with engine.begin() as conn:
                for table in ('model_predictions', 'imaging_visualizations'):
                    for field in ('record_schema_version', 'data_version', 'record_key_version', 'envelope_status', 'record_origin', 'storage_context'):
                        conn.execute(text(f'ALTER TABLE {table} DROP COLUMN {field}'))
        else:
            raise HTTPException(422, 'Explicit supported synthetic fixture required')
        return {'synthetic_temporary_store': True, 'mode': payload.mode}

    uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[1]), log_level='warning')
