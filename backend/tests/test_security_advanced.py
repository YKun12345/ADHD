"""Independent behavioral review of authenticated storage and audit boundaries.

Application imports stay inside tests because the shared client fixture reloads app modules.
"""
from __future__ import annotations

import base64
import json
import sqlite3
from pathlib import Path

import pytest
from sqlalchemy import delete, select, text

from backend.tests.test_security_regressions import actors, initialize, make_scale


def audit(client, actors, source_type="scale", **options):
    return client.post("/api/v1/security/dac/temporal_audits",
                       headers=actors["dac"]["headers"],
                       json={"patient_id": actors["patient_id"], "source_type": source_type, **options})


def add_patient(actors, label="second"):
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User, UserRole
    from backend.app.models.patient import Patient, PatientType
    with SessionLocal() as db:
        user = User(email=label + "@example.org", full_name=label + "-private-name",
                    password_hash="unused", role=UserRole.PATIENT, consent_agreed=True, is_active=True)
        db.add(user)
        db.flush()
        patient = Patient(user_id=user.id, assigned_researcher_id=actors["doctor"]["id"],
                          patient_type=PatientType.ADULT)
        db.add(patient)
        db.commit()
        return patient.id


def capture_scale(patient_id, scale_type="asrs", score=18):
    from backend.app.db.session import SessionLocal
    from backend.app.models.patient import Patient
    from backend.app.models.scale_result import ScaleResult
    from backend.app.services.security_service import capture_scale_result_cipher
    with SessionLocal() as db:
        source = ScaleResult(patient_id=patient_id, scale_type=scale_type,
                             score_json={"private_note": "original", "radar_scores": {}},
                             total_score=score, risk_level="low")
        db.add(source)
        db.flush()
        evidence = capture_scale_result_cipher(db, db.get(Patient, patient_id), source)
        db.commit()
        return source.id, evidence.id


@pytest.mark.parametrize("mutation", ["ciphertext", "context", "key"])
def test_aes_gcm_rejects_authenticated_envelope_changes(client, monkeypatch, mutation):
    from cryptography.exceptions import InvalidTag
    from backend.app.core import data_encryption as encryption
    envelope = encryption.encrypt_value({"clinical": "protected"}, "field:one")
    context = "field:one"
    if mutation == "ciphertext":
        raw = bytearray(base64.urlsafe_b64decode(envelope[len(encryption.PREFIX):]))
        raw[-1] ^= 1
        envelope = encryption.PREFIX + base64.urlsafe_b64encode(raw).decode()
    elif mutation == "context":
        context = "field:another"
    else:
        monkeypatch.setattr(encryption.settings, "DATA_ENCRYPTION_KEY", base64.urlsafe_b64encode(b"Z" * 32).decode())
    with pytest.raises(InvalidTag):
        encryption.decrypt_value(envelope, context)


def test_runtime_orm_rejects_valid_plaintext_downgrade(client, actors):
    from backend.app.db.session import SessionLocal, engine
    from backend.app.models.scale_result import ScaleResult
    with SessionLocal() as db:
        item = ScaleResult(patient_id=actors["patient_id"], scale_type="asrs",
                           score_json={}, total_score=18, risk_level="low")
        db.add(item)
        db.commit()
        source_id = item.id
    with engine.begin() as connection:
        connection.execute(text("UPDATE scale_results SET total_score='99' WHERE id=:id"), {"id": source_id})
    with SessionLocal() as db, pytest.raises(ValueError, match="Unauthenticated"):
        db.get(ScaleResult, source_id)


def test_source_digest_binds_unprojected_clinical_fields(client, actors):
    initialize(client, actors)
    source_id, evidence_id, ciphertext, digest = make_scale(actors)
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    from backend.app.models.security import SecurityCipherRecord
    from backend.app.services.security_service import sync_security_runtime_entities
    with SessionLocal() as db:
        item = db.get(ScaleResult, source_id)
        item.score_json = {**item.score_json, "secret_note": "modified outside numeric projection"}
        db.commit()
        sync_security_runtime_entities(db)
        db.commit()
        evidence = db.get(SecurityCipherRecord, evidence_id)
        assert (evidence.encrypted_payload, evidence.integrity_digest) == (ciphertext, digest)
    response = audit(client, actors)
    assert response.status_code == 200, response.text
    assert response.json()["verification_passed"] is False
    assert response.json()["decrypted_stats"]["stats"] == {}


def test_authorized_versions_append_chain_and_unchanged_capture_is_idempotent(client, actors):
    initialize(client, actors)
    source_id, first_id, first_cipher, first_digest = make_scale(actors)
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    from backend.app.models.patient import Patient
    from backend.app.models.security import SecurityCipherRecord
    from backend.app.services.security_service import capture_scale_result_cipher
    versions = [first_id]
    with SessionLocal() as db:
        source = db.get(ScaleResult, source_id)
        patient = db.get(Patient, actors["patient_id"])
        assert capture_scale_result_cipher(db, patient, source).id == first_id
        for score in (22, 27):
            source.total_score = score
            current = capture_scale_result_cipher(db, patient, source)
            db.commit()
            versions.append(current.id)
        records = [db.get(SecurityCipherRecord, record_id) for record_id in versions]
        assert [record.metadata_json["evidence_version"] for record in records] == [1, 2, 3]
        assert [record.metadata_json["supersedes_record_id"] for record in records] == [None, first_id, versions[1]]
        assert records[2].metadata_json["previous_integrity_digest"] == records[1].integrity_digest
        assert (records[0].encrypted_payload, records[0].integrity_digest) == (first_cipher, first_digest)
    result = audit(client, actors).json()
    assert result["verification_passed"] is True
    assert result["verification_details"]["historical_evidence_count"] == 3
    assert result["decrypted_stats"]["record_count"] == 1
    assert result["decrypted_stats"]["stats"]["total_score"]["sum"] == 270


def test_deleted_evidence_predecessor_fails_verification(client, actors):
    initialize(client, actors)
    source_id, evidence_id, *_ = make_scale(actors)
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    from backend.app.models.patient import Patient
    from backend.app.models.security import SecurityCipherRecord
    from backend.app.services.security_service import capture_scale_result_cipher
    with SessionLocal() as db:
        source = db.get(ScaleResult, source_id)
        source.total_score = 21
        capture_scale_result_cipher(db, db.get(Patient, actors["patient_id"]), source)
        db.commit()
        db.execute(delete(SecurityCipherRecord).where(SecurityCipherRecord.id == evidence_id))
        db.commit()
    result = audit(client, actors).json()
    assert result["verification_passed"] is False
    assert result["decrypted_stats"]["stats"] == {}


def test_tampered_authenticated_source_fails_audit_without_statistics(client, actors):
    initialize(client, actors)
    source_id, *_ = make_scale(actors)
    from backend.app.db.session import engine
    with engine.begin() as connection:
        envelope = connection.execute(text("SELECT score_json FROM scale_results WHERE id=:id"), {"id": source_id}).scalar_one()
        prefix, payload = envelope[:10], envelope[10:]
        raw = bytearray(base64.urlsafe_b64decode(payload))
        raw[-1] ^= 1
        connection.execute(text("UPDATE scale_results SET score_json=:value WHERE id=:id"),
                           {"id": source_id, "value": prefix + base64.urlsafe_b64encode(raw).decode()})
    response = audit(client, actors)
    assert response.status_code == 200, response.text
    assert response.json()["verification_passed"] is False
    assert response.json()["decrypted_stats"]["stats"] == {}


def test_spatial_service_rejects_non_dac_before_assignment_processing(client, actors):
    initialize(client, actors)
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.services.security_service import run_spatial_audit
    with SessionLocal() as db:
        requester = db.get(User, actors["doctor"]["id"])
        with pytest.raises(ValueError, match="DAC permission"):
            run_spatial_audit(db, patient_ids=[actors["patient_id"]], source_type="scale", requester=requester)


def test_inactive_assignment_survives_runtime_sync_and_blocks_new_evidence(client, actors):
    initialize(client, actors)
    make_scale(actors)
    from backend.app.db.session import SessionLocal
    from backend.app.models.patient import Patient
    from backend.app.models.scale_result import ScaleResult
    from backend.app.models.security import SecurityPatientAssignment, SecurityCipherRecord
    from backend.app.services.security_service import sync_security_runtime_entities, capture_scale_result_cipher
    with SessionLocal() as db:
        assignment = db.scalar(select(SecurityPatientAssignment).where(SecurityPatientAssignment.patient_id == actors["patient_id"]))
        assignment.assignment_status = "inactive"
        db.commit()
        sync_security_runtime_entities(db)
        source = ScaleResult(patient_id=actors["patient_id"], scale_type="asrs",
                             score_json={}, total_score=19, risk_level="low")
        db.add(source)
        db.flush()
        assert capture_scale_result_cipher(db, db.get(Patient, actors["patient_id"]), source) is None
        db.commit()
        assert assignment.assignment_status == "inactive"
        assert len(db.scalars(select(SecurityCipherRecord)).all()) == 1
    response = audit(client, actors)
    assert response.status_code in (400, 403)


def test_access_audit_tracks_target_patient_and_scopes_dac_logs(client, actors):
    initialize(client, actors)
    make_scale(actors)
    target = f"/api/v1/security/patient/{actors['patient_id']}/overview"
    assert client.get(target, headers=actors["doctor"]["headers"]).status_code == 200
    assert client.get(target, headers=actors["outsider"]["headers"]).status_code == 403
    response = client.get("/api/v1/security/dac/audit_logs", headers=actors["dac"]["headers"])
    assert response.status_code == 200
    events = [row for row in response.json()["items"] if row["detail"].get("path") == target]
    assert any(row["actor_user_id"] == actors["doctor"]["id"] and row["action"] == "data_read" for row in events)
    assert any(row["actor_user_id"] == actors["outsider"]["id"] and row["action"] == "access_denied" for row in events)
    assert all(row["patient_id"] == actors["patient_id"] for row in events)
    assert "private-clinical-payload" not in response.text
    other = client.get("/api/v1/security/dac/audit_logs", headers=actors["dac2"]["headers"])
    assert not any(row["patient_id"] == actors["patient_id"] for row in other.json()["items"])


@pytest.mark.parametrize("mutation", ["middle_deleted", "tail_deleted", "ids_reordered", "all_deleted"])
def test_log_chain_detects_deletion_and_reordering(client, actors, mutation):
    initialize(client, actors)
    make_scale(actors)
    from backend.app.db.session import SessionLocal
    from backend.app.models.security import SecurityAuditLog, SecurityLogChainHead
    from backend.app.services.security_service import _append_audit_log, verify_audit_log_chain
    with SessionLocal() as db:
        for index in range(3):
            _append_audit_log(db, action="independent_probe", status="success", message=str(index))
        db.commit()
        assert verify_audit_log_chain(db)["verified"] is True
        ids = list(db.scalars(select(SecurityAuditLog.id).order_by(SecurityAuditLog.id)))
        if mutation == "middle_deleted":
            db.execute(delete(SecurityAuditLog).where(SecurityAuditLog.id == ids[-2]))
        elif mutation == "tail_deleted":
            db.execute(delete(SecurityAuditLog).where(SecurityAuditLog.id == ids[-1]))
        elif mutation == "ids_reordered":
            db.execute(text("UPDATE security_audit_logs SET id=:new WHERE id=:old"), {"new": 100000, "old": ids[-2]})
        else:
            db.execute(delete(SecurityAuditLog))
            db.execute(delete(SecurityLogChainHead))
        db.commit()
        result = verify_audit_log_chain(db)
        assert result["verified"] is False
        if mutation == "all_deleted":
            with pytest.raises(ValueError, match="anchor"):
                _append_audit_log(db, action="new_after_wipe", status="success", message="must not silently re-anchor")


def test_temporal_aggregation_respects_declared_packing_limit(client, actors, monkeypatch):
    from backend.app.services import security_service
    monkeypatch.setattr(security_service, "DEFAULT_MAX_RECORDS", 1)
    initialize(client, actors)
    capture_scale(actors["patient_id"], score=18)
    capture_scale(actors["patient_id"], score=19)
    response = audit(client, actors)
    assert response.status_code == 400, response.text
    assert "bounds" in response.text


def test_multiple_scale_types_require_explicit_selection(client, actors):
    initialize(client, actors)
    _, first = capture_scale(actors["patient_id"], "asrs", 18)
    capture_scale(actors["patient_id"], "snap-iv", 30)
    assert audit(client, actors).status_code == 400
    selected = audit(client, actors, audit_group="scale:asrs")
    assert selected.status_code == 200, selected.text
    result = selected.json()
    assert result["verification_passed"] is True
    assert result["verification_details"]["verified_record_ids"] == [first]
    assert result["decrypted_stats"]["record_count"] == 1
    assert result["decrypted_stats"]["stats"]["total_score"]["sum"] == 180


def test_cognitive_audit_separates_protocol_source_version_and_age(client, actors):
    initialize(client, actors)
    from backend.app.db.session import SessionLocal
    from backend.app.models.cognitive_test import CognitiveTest
    from backend.app.models.patient import Patient
    from backend.app.services.security_service import capture_cognitive_test_cipher
    variants = [("patient_web", "patient-web-preview-v1", 1, "unspecified"),
                ("miniprogram", "continuous-mobile-v4", 6, "adult"),
                ("miniprogram", "continuous-mobile-v4", 6, "child"),
                ("miniprogram", "continuous-mobile-v4", 7, "adult")]
    ids = []
    with SessionLocal() as db:
        patient = db.get(Patient, actors["patient_id"])
        for source, protocol, version, age in variants:
            item = CognitiveTest(patient_id=patient.id, test_type="trail", result_json={
                "source": source, "protocol_id": protocol, "protocol_schema_version": version, "age_group": age,
                "raw_result": {"elapsed_ms": 10_000, "accuracy": 90, "errors": 1}})
            db.add(item)
            db.flush()
            ids.append(capture_cognitive_test_cipher(db, patient, item).id)
        db.commit()
    assert audit(client, actors, "cognitive").status_code == 400
    group = "cognitive:trail|miniprogram|continuous-mobile-v4|6|adult"
    response = audit(client, actors, "cognitive", audit_group=group)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["verification_passed"] is True
    assert result["verification_details"]["verified_record_ids"] == [ids[1]]
    assert result["verification_details"]["audit_group"] == group


def legacy_storage(client, tmp_path, monkeypatch, outside=False):
    from sqlalchemy import create_engine
    from backend.app.db import encryption_migration as migration
    from backend.app.core.config import settings
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    upload = (tmp_path if outside else upload_root) / "clinical.csv"
    upload.write_bytes(b"private-upload-content\n1,2,3\n")
    engine = create_engine(f"sqlite:///{(tmp_path / 'legacy.db').as_posix()}")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL)"))
        connection.execute(text("INSERT INTO users VALUES (1, 'private-legacy-name')"))
        connection.execute(text("CREATE TABLE uploads (id INTEGER PRIMARY KEY, stored_path TEXT NOT NULL, file_name TEXT NOT NULL, note TEXT)"))
        connection.execute(text("INSERT INTO uploads VALUES (1, :path, 'clinical.csv', NULL)"), {"path": str(upload)})
    monkeypatch.setattr(settings, "UPLOAD_ROOT", str(upload_root))
    monkeypatch.setattr(migration, "BACKUP_ROOT", tmp_path / "backups")
    return engine, upload, migration


def test_migration_is_idempotent_and_encrypted_backup_restores_original_contents(client, tmp_path, monkeypatch):
    engine, upload, migration = legacy_storage(client, tmp_path, monkeypatch)
    from backend.app.core.data_encryption import FILE_MAGIC, decrypt_value, PREFIX
    try:
        original = upload.read_bytes()
        first = migration.migrate_sensitive_storage(engine)
        assert first["encrypted_values"] == 2
        assert first["encrypted_files"] == 1
        backup = Path(first["backup_directory"])
        assert not list(backup.rglob("*.tmp"))
        assert all(path.suffix == ".enc" for path in backup.rglob("*") if path.is_file())
        assert b"private-legacy-name" not in b"".join(path.read_bytes() for path in backup.rglob("*.enc"))
        assert upload.read_bytes().startswith(FILE_MAGIC)
        with engine.connect() as connection:
            value = connection.execute(text("SELECT full_name FROM users")).scalar_one()
            assert value.startswith(PREFIX)
            assert decrypt_value(value, "users.full_name") == "private-legacy-name"
        current_upload = upload.read_bytes()
        second = migration.migrate_sensitive_storage(engine)
        assert second == {"encrypted_values": 0, "encrypted_files": 0}
        assert upload.read_bytes() == current_upload
        assert len(list((tmp_path / "backups").iterdir())) == 1
        destination = tmp_path / "restored"
        assert migration.restore_backup(backup, destination) == 2
        assert (destination / "uploads" / "clinical.csv").read_bytes() == original
        with sqlite3.connect(destination / "database-before-encryption.db") as connection:
            assert connection.execute("SELECT full_name FROM users").fetchone()[0] == "private-legacy-name"
        with pytest.raises(ValueError, match="empty"):
            migration.restore_backup(backup, destination)
    finally:
        engine.dispose()


def test_migration_refuses_upload_outside_root_before_mutation(client, tmp_path, monkeypatch):
    engine, upload, migration = legacy_storage(client, tmp_path, monkeypatch, outside=True)
    try:
        original = upload.read_bytes()
        with pytest.raises(RuntimeError, match="outside"):
            migration.migrate_sensitive_storage(engine)
        assert upload.read_bytes() == original
        with engine.connect() as connection:
            assert connection.execute(text("SELECT full_name FROM users")).scalar_one() == "private-legacy-name"
        assert not (tmp_path / "backups").exists()
    finally:
        engine.dispose()


def test_backup_authentication_failure_does_not_partially_restore(client, tmp_path, monkeypatch):
    engine, _, migration = legacy_storage(client, tmp_path, monkeypatch)
    from cryptography.exceptions import InvalidTag
    try:
        backup = Path(migration.migrate_sensitive_storage(engine)["backup_directory"])
        encrypted = list(backup.rglob("*.enc"))[-1]
        payload = bytearray(encrypted.read_bytes())
        payload[-1] ^= 1
        encrypted.write_bytes(payload)
        destination = tmp_path / "must-stay-empty"
        with pytest.raises(InvalidTag):
            migration.restore_backup(backup, destination)
        assert not destination.exists()
    finally:
        engine.dispose()


def test_failed_backup_encryption_does_not_leave_plaintext_snapshot(client, tmp_path, monkeypatch):
    engine, _, migration = legacy_storage(client, tmp_path, monkeypatch)
    def fail(*args, **kwargs):
        raise OSError("simulated backup encryption/write failure")
    monkeypatch.setattr(migration, "_write_backup", fail)
    try:
        with pytest.raises(OSError, match="simulated"):
            migration.migrate_sensitive_storage(engine)
        leftovers = list((tmp_path / "backups").rglob("*.tmp"))
        assert leftovers == [], "failed encrypted backup must remove its plaintext temporary SQLite snapshot"
        with engine.connect() as connection:
            assert connection.execute(text("SELECT full_name FROM users")).scalar_one() == "private-legacy-name"
    finally:
        engine.dispose()


def test_source_and_latest_evidence_rollback_cannot_restore_verified_state(client, actors):
    """Replay valid old AES bytes plus drop the newer evidence; log history remains intact."""
    initialize(client, actors)
    source_id, first_id, *_ = make_scale(actors)
    from backend.app.db.session import SessionLocal, engine
    from backend.app.models.scale_result import ScaleResult
    from backend.app.models.patient import Patient
    from backend.app.models.security import SecurityCipherRecord
    from backend.app.services.security_service import capture_scale_result_cipher
    with engine.connect() as connection:
        original_score_envelope = connection.execute(
            text("SELECT total_score FROM scale_results WHERE id=:id"), {"id": source_id}).scalar_one()
    with SessionLocal() as db:
        source = db.get(ScaleResult, source_id)
        source.total_score = 27
        newest = capture_scale_result_cipher(db, db.get(Patient, actors["patient_id"]), source)
        db.commit()
        newest_id = newest.id
        assert newest_id != first_id
    with engine.begin() as connection:
        connection.execute(text("UPDATE scale_results SET total_score=:value WHERE id=:id"),
                           {"value": original_score_envelope, "id": source_id})
        connection.execute(text("DELETE FROM security_cipher_records WHERE id=:id"), {"id": newest_id})
    response = audit(client, actors)
    assert response.status_code == 200, response.text
    assert response.json()["verification_passed"] is False, "authenticated rollback must conflict with retained append history"
    assert response.json()["decrypted_stats"]["stats"] == {}


def test_spatial_selection_uses_same_scale_group_for_each_authorized_patient(client, actors):
    initialize(client, actors)
    second = add_patient(actors)
    _, first_evidence = capture_scale(actors["patient_id"], "asrs", 18)
    _, second_evidence = capture_scale(second, "asrs", 20)
    capture_scale(second, "snap-iv", 40)
    request = {"patient_ids": [actors["patient_id"], second], "source_type": "scale"}
    endpoint = "/api/v1/security/dac/spatial_audits"
    assert client.post(endpoint, headers=actors["dac"]["headers"], json=request).status_code == 400
    response = client.post(endpoint, headers=actors["dac"]["headers"], json={**request, "audit_group": "scale:asrs"})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["verification_passed"] is True
    assert set(result["verification_details"]["verified_record_ids"]) == {first_evidence, second_evidence}
    assert result["decrypted_stats"]["record_count"] == 2
    assert result["decrypted_stats"]["stats"]["total_score"]["sum"] == 380


def test_spatial_audit_cannot_include_patient_assigned_to_another_dac(client, actors):
    initialize(client, actors)
    second = add_patient(actors)
    capture_scale(actors["patient_id"])
    capture_scale(second)
    from backend.app.db.session import SessionLocal
    from backend.app.models.security import SecurityPatientAssignment
    with SessionLocal() as db:
        assignment = db.scalar(select(SecurityPatientAssignment).where(SecurityPatientAssignment.patient_id == second))
        assignment.assigned_dac_user_id = actors["dac2"]["id"]
        db.commit()
    response = client.post("/api/v1/security/dac/spatial_audits", headers=actors["dac"]["headers"],
                           json={"patient_ids": [actors["patient_id"], second], "source_type": "scale"})
    assert response.status_code in (400, 403)
    assert "not assigned" in response.text


def test_concurrent_authenticated_reads_preserve_one_linear_audit_chain(client, actors):
    from concurrent.futures import ThreadPoolExecutor
    initialize(client, actors)
    target = f"/api/v1/security/patient/{actors['patient_id']}/overview"
    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(lambda _: client.get(target, headers=actors["doctor"]["headers"]), range(8)))
    assert all(response.status_code == 200 for response in responses), [response.status_code for response in responses]
    from backend.app.db.session import SessionLocal
    from backend.app.services.security_service import verify_audit_log_chain
    with SessionLocal() as db:
        result = verify_audit_log_chain(db)
        assert result["verified"] is True, result


def test_inactive_assignment_hides_other_actors_patient_access_logs(client, actors):
    initialize(client, actors)
    target = f"/api/v1/security/patient/{actors['patient_id']}/overview"
    assert client.get(target, headers=actors["doctor"]["headers"]).status_code == 200
    from backend.app.db.session import SessionLocal
    from backend.app.models.security import SecurityPatientAssignment
    with SessionLocal() as db:
        assignment = db.scalar(select(SecurityPatientAssignment).where(
            SecurityPatientAssignment.patient_id == actors["patient_id"]))
        assignment.assignment_status = "inactive"
        db.commit()
    assert client.get(target, headers=actors["dac"]["headers"]).status_code == 403
    response = client.get("/api/v1/security/dac/audit_logs", headers=actors["dac"]["headers"])
    assert response.status_code == 200
    assert not any(row["patient_id"] == actors["patient_id"]
                   and row["actor_user_id"] != actors["dac"]["id"]
                   for row in response.json()["items"]), "revoked patient assignment cannot expose other actors' access history"


def test_plaintext_config_version_downgrade_cannot_hide_erased_log_chain(client, actors):
    initialize(client, actors)
    make_scale(actors)
    from backend.app.db.session import SessionLocal, engine
    from backend.app.services.security_service import verify_audit_log_chain
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM security_audit_logs"))
        connection.execute(text("DELETE FROM security_log_chain_head"))
        connection.execute(text("UPDATE security_system_configs SET system_version='vmemda-lite-v1'"))
    with SessionLocal() as db:
        result = verify_audit_log_chain(db)
        assert result["verified"] is False, "unprotected config metadata cannot downgrade authenticated log requirements"


@pytest.mark.parametrize("mutation", ["sequence", "public_modulus", "system_version"])
def test_audit_rejects_tampered_authenticated_public_configuration(client, actors, mutation):
    initialize(client, actors)
    make_scale(actors)
    from backend.app.db.session import SessionLocal
    from backend.app.services.security_service import get_security_config
    with SessionLocal() as db:
        config = get_security_config(db)
        if mutation == "sequence":
            profiles = json.loads(json.dumps(config.profile_params_json))
            profiles["scale"]["sequence"][0] = "2"
            config.profile_params_json = profiles
        elif mutation == "public_modulus":
            public = {**config.public_params_json}
            public["n"] = str(int(public["n"]) + 2)
            config.public_params_json = public
        else:
            config.system_version = "vmemda-lite-v1"
        db.commit()
    response = audit(client, actors)
    assert response.status_code == 400, response.text
    assert "configuration integrity" in response.text.lower()
    from backend.app.models.security import SecurityAuditTask
    with SessionLocal() as db:
        assert not db.scalars(select(SecurityAuditTask)).all(), "invalid configuration must fail before recording audit results"


def test_deleted_backup_component_prevents_incomplete_restore(client, tmp_path, monkeypatch):
    engine, _, migration = legacy_storage(client, tmp_path, monkeypatch)
    try:
        backup = Path(migration.migrate_sensitive_storage(engine)["backup_directory"])
        (backup / "uploads" / "clinical.csv.enc").unlink()
        destination = tmp_path / "must-not-restore-partial-backup"
        with pytest.raises(ValueError, match="(?i)(missing|incomplete|manifest)"):
            migration.restore_backup(backup, destination)
        assert not destination.exists()
    finally:
        engine.dispose()


def test_evidence_creation_rejects_tampered_public_configuration(client, actors):
    initialize(client, actors)
    source_id, *_ = make_scale(actors)
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    from backend.app.models.patient import Patient
    from backend.app.services.security_service import get_security_config, capture_scale_result_cipher
    with SessionLocal() as db:
        config = get_security_config(db)
        config.public_params_json = {**config.public_params_json, "g": "1"}
        db.commit()
        source = db.get(ScaleResult, source_id)
        source.total_score = 27
        with pytest.raises(ValueError, match="configuration integrity"):
            capture_scale_result_cipher(db, db.get(Patient, actors["patient_id"]), source)


@pytest.mark.parametrize("mutation", ["manifest_deleted", "extra_component"])
def test_backup_manifest_enforces_exact_component_set(client, tmp_path, monkeypatch, mutation):
    engine, _, migration = legacy_storage(client, tmp_path, monkeypatch)
    from backend.app.core.data_encryption import FILE_MAGIC, encrypt_bytes
    try:
        backup = Path(migration.migrate_sensitive_storage(engine)["backup_directory"])
        if mutation == "manifest_deleted":
            (backup / "backup-manifest.json.enc").unlink()
        else:
            (backup / "unexpected.csv.enc").write_bytes(
                FILE_MAGIC + encrypt_bytes(b"additional-private-file", "migration-backup:unexpected.csv"))
        destination = tmp_path / "must-not-restore-altered-file-set"
        with pytest.raises(ValueError):
            migration.restore_backup(backup, destination)
        assert not destination.exists()
    finally:
        engine.dispose()


def test_authenticated_backup_manifest_cannot_escape_restore_directory(client, tmp_path, monkeypatch):
    engine, _, migration = legacy_storage(client, tmp_path, monkeypatch)
    from backend.app.core.data_encryption import FILE_MAGIC, decrypt_bytes, encrypt_bytes
    import hashlib
    try:
        backup = Path(migration.migrate_sensitive_storage(engine)["backup_directory"])
        manifest_path = backup / "backup-manifest.json.enc"
        manifest = json.loads(decrypt_bytes(manifest_path.read_bytes()[len(FILE_MAGIC):],
                                           "migration-backup:backup-manifest.json"))
        existing = manifest["files"][0]
        (backup / existing["path"]).unlink()
        unsafe_path = "../outside.csv.enc"
        payload = FILE_MAGIC + encrypt_bytes(b"must-not-be-written", "migration-backup:../outside.csv")
        (backup.parent / "outside.csv.enc").write_bytes(payload)
        existing.update(path=unsafe_path, size=len(payload), sha256=hashlib.sha256(payload).hexdigest())
        manifest_path.write_bytes(FILE_MAGIC + encrypt_bytes(json.dumps(manifest).encode("utf8"),
                                                             "migration-backup:backup-manifest.json"))
        protected_neighbor = tmp_path / "outside.csv"
        protected_neighbor.write_bytes(b"original-content")
        destination = tmp_path / "must-not-write-outside"
        with pytest.raises(ValueError):
            migration.restore_backup(backup, destination)
        assert not destination.exists()
        assert protected_neighbor.read_bytes() == b"original-content"
    finally:
        engine.dispose()


def test_migration_backup_preserves_uploads_that_were_already_encrypted(client, tmp_path, monkeypatch):
    engine, upload, migration = legacy_storage(client, tmp_path, monkeypatch)
    from backend.app.core.data_encryption import FILE_MAGIC, encrypt_bytes
    protected = upload.parent / "already-encrypted.csv"
    protected_bytes = FILE_MAGIC + encrypt_bytes(b"existing-private-file", "upload:already-encrypted.csv")
    protected.write_bytes(protected_bytes)
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO uploads VALUES (2, :path, 'already-encrypted.csv', NULL)"),
                           {"path": str(protected)})
    try:
        backup = Path(migration.migrate_sensitive_storage(engine)["backup_directory"])
        assert protected.read_bytes() == protected_bytes
        destination = tmp_path / "complete-restore"
        migration.restore_backup(backup, destination)
        assert (destination / "uploads" / "already-encrypted.csv").read_bytes() == protected_bytes, \
            "database backup must include every referenced upload, including previously encrypted files"
    finally:
        engine.dispose()
