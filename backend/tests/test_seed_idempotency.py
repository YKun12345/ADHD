from __future__ import annotations

import pytest
from sqlalchemy import func, select


def test_demo_seed_is_idempotent_and_contract_correct(client) -> None:
    from backend.app.db.session import SessionLocal
    from backend.app.models.cognitive_test import CognitiveTest
    from backend.app.models.imaging_visualization import ImagingVisualization
    from backend.app.models.model_prediction import ModelPrediction
    from backend.app.models.patient import Patient
    from backend.app.models.scale_result import ScaleResult
    from backend.app.models.tracking_log import TrackingLog
    from backend.app.models.user import User
    from backend.scripts.seed_demo_data import (
        ADULT_EMAIL,
        CHILD_EMAIL,
        DAC_EMAIL,
        DOCTOR_EMAIL,
        seed_demo_data,
    )

    seed_demo_data()
    seed_demo_data()

    demo_emails = (ADULT_EMAIL, CHILD_EMAIL, DOCTOR_EMAIL, DAC_EMAIL)
    expected_types = {
        "reaction",
        "simple_reaction",
        "stroop",
        "trail",
        "flanker",
        "nback",
        "digit",
    }

    with SessionLocal() as db:
        demo_users = list(db.scalars(select(User).where(User.email.in_(demo_emails))).all())
        assert len(demo_users) == 4

        dac_user = next(user for user in demo_users if user.email == DAC_EMAIL)
        assert dac_user.subrole.value == "dac"

        patient_user_ids = [
            user.id
            for user in demo_users
            if user.email not in {DOCTOR_EMAIL, DAC_EMAIL}
        ]
        patients = list(db.scalars(select(Patient).where(Patient.user_id.in_(patient_user_ids))).all())
        assert len(patients) == 2

        for patient in patients:
            assert db.scalar(
                select(func.count()).select_from(ScaleResult).where(ScaleResult.patient_id == patient.id)
            ) == 1
            cognitive_rows = list(
                db.scalars(
                    select(CognitiveTest)
                    .where(CognitiveTest.patient_id == patient.id)
                    .order_by(CognitiveTest.test_type)
                ).all()
            )
            assert len(cognitive_rows) == 7
            assert {row.test_type for row in cognitive_rows} == expected_types
            for row in cognitive_rows:
                assert isinstance(row.result_json.get("raw_result"), dict)
                assert row.result_json.get("finished_at")
                assert row.result_json.get("metrics")

            tracking_rows = list(
                db.scalars(select(TrackingLog).where(TrackingLog.patient_id == patient.id)).all()
            )
            assert len(tracking_rows) == 14
            assert len({row.day_index for row in tracking_rows}) == 14
            assert db.scalar(
                select(func.count())
                .select_from(ImagingVisualization)
                .where(ImagingVisualization.patient_id == patient.id)
            ) == 2
            assert db.scalar(
                select(func.count())
                .select_from(ModelPrediction)
                .where(ModelPrediction.patient_id == patient.id)
            ) == 1


def test_demo_seed_is_rejected_in_production(client, monkeypatch) -> None:
    from backend.scripts.seed_demo_data import seed_demo_data

    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(RuntimeError, match="disabled in production"):
        seed_demo_data()
