"""Clinical authority must retain its declared purpose at read and commit time."""
import pytest
from fastapi import HTTPException
from backend.tests.test_authorization_edges import active_care


@pytest.mark.parametrize("changed_purpose",["research","unrecognized-purpose"])
def test_other_purpose_cannot_supply_clinical_report_or_patient_list(client,changed_purpose):
    _,doctor,_,_,pid,relationship = active_care(client,suffix="purpose-"+changed_purpose)
    report = f"/api/v1/doctor/patient/{pid}/report"
    assert client.get(report,headers=doctor).status_code == 200
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        row = db.get(CareRelationship,relationship["id"])
        row.purpose = changed_purpose
        db.commit()
        assert ledger.matches(row), "This probe isolates purpose from revision/ledger denial."
    denied = client.get(report,headers=doctor)
    assert denied.status_code == 403,denied.text
    patients = client.get("/api/v1/doctor/my_patients",headers=doctor)
    assert patients.status_code == 200 and patients.json()["items"] == [],patients.text


def test_original_receipts_recheck_clinical_purpose_before_commit(client):
    doctor,_,_,_,pid,relationship = active_care(client,suffix="purpose-commit")
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.models.user import User
    from backend.app.services.identity_access import require_patient_access,recheck_request_authority
    with SessionLocal() as db:
        require_patient_access(db,db.get(User,doctor["user"]["id"]),pid,"care",relationship_id=relationship["id"])
        assert db.info["authorization_receipts"]
        with SessionLocal() as changed:
            changed.get(CareRelationship,relationship["id"]).purpose = "research"
            changed.commit()
        with pytest.raises(HTTPException) as failure:
            recheck_request_authority(db)
        assert failure.value.status_code == 403
