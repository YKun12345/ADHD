"""Successor responsibility uses its actual accepted new scope, never the old grant."""
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from backend.app.models.attention import AttentionItem
from backend.app.models.care_transfer import CareTransferWorkItem, CareTransferWorkAction
from backend.app.schemas.care_transfer import TransferWorkActionCreate
from backend.app.services.assessment_service import authorization_snapshot
from backend.app.services.attention_action_service import _source
from backend.app.services.attention_service import verify_attention
from backend.app.services.care_transfer_access import (ACTION_FIELDS, WORK_FIELDS, action_ack, audit, issue_context,
    metadata, open_context, original_authority, original_historical_authority, read_work_authority, restore_authority, save_authority,
    storage_boundary, verify_action, work_response, work_row, work_state, validated_payload)
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.event_service import append_care_event

TARGETS = {"acknowledge": "acknowledged", "resolve": "resolved", "close_with_reason": "closed_with_reason"}


def allowed(row):
    return {"open": ["acknowledge", "close_with_reason"], "acknowledged": ["resolve", "close_with_reason"]}.get(row.status, [])


def original_evidence(db, row):
    # This is the explicitly selected root attention only. No sibling assessment
    # items, private conversations or unselected evidence are included.
    attention = db.get(AttentionItem, row.original_attention_id, populate_existing=True)
    verify_attention(attention)
    _source(db, attention)
    value = {"attention_id": attention.id, "source_event_id": attention.source_event_id, "kind": attention.kind,
        "original_doctor_user_id": attention.responsible_doctor_id, "assessment_id": attention.assessment_id,
        "quality_reasons": attention.detail["quality_reasons"], "original_response_coverage": attention.detail["response_coverage"]}
    if attention.submission_id:
        from backend.app.models.submission import SubmissionRecord
        from backend.app.services.submission_service import _verify_record, context_dict
        submission = db.scalar(select(SubmissionRecord).where(SubmissionRecord.submission_id == attention.submission_id))
        _verify_record(db, submission)
        if submission.kind == "scale":
            from backend.app.models.scale_result import ScaleResult
            result = db.get(ScaleResult, submission.scale_result_id)
            server_result = {"kind": "scale", "id": result.id, "scale_type": result.scale_type,
                "score_json": result.score_json, "total_score": result.total_score, "risk_level": result.risk_level, "legacy": result.legacy}
        else:
            from backend.app.models.cognitive_test import CognitiveTest
            result = db.get(CognitiveTest, submission.cognitive_result_id)
            server_result = {"kind": "cognitive", "id": result.id, "test_type": result.test_type,
                "result_json": result.result_json, "legacy": result.legacy}
        value["evidence"] = {"submission_id": submission.submission_id, "context": context_dict(submission),
            "client_evidence": submission.content, "quality_status": submission.quality_status,
            "quality_reasons": submission.quality_reasons, "server_result": server_result, "demonstration_only": True}
    return value


@storage_boundary
def detail(db, user, identifier):
    row = work_row(db, identifier)
    read_work_authority(db, user, row)
    actions, token = [], None
    if allowed(row):
        saved = save_authority(db)
        try:
            basis = read_work_authority(db, user, row, processing=True)
            actions = allowed(row)
            token = issue_context("work", {"actor_user_id": user.id, "actor_identity_basis": basis,
                "patient_id": row.patient_id, "work_item_id": row.id, "expected_version": row.version,
                "previous_status": row.status, "work_context": metadata(row, WORK_FIELDS),
                "authorization_snapshot": authorization_snapshot(db)})
        except HTTPException as exc:
            if exc.status_code not in {403, 409}:
                raise
            restore_authority(db, saved)
    result = {"work": work_response(db, row), "original_evidence": original_evidence(db, row), "allowed_actions": actions,
        "action_context": token, "action_context_digest": canonical_digest(token) if token else None}
    audit(db, user, row.patient_id, "care_transfer_work_detail_read", work_item_id=row.id)
    return result


def _recover(db, user, action, *, historical=False):
    verify_action(action)
    if user.id != action.actor_user_id:
        raise HTTPException(403, "Only the actual original actor can recover this work-action ACK.")
    row = work_row(db, action.work_item_id)
    basis = read_work_authority(db, user, row, processing=not historical)
    if basis != action.actor_identity_basis:
        raise HTTPException(409, "This original action cannot borrow another responsibility basis.")
    (original_historical_authority if historical else original_authority)(db, action.authorization_snapshot)
    audit(db, user, row.patient_id, "care_transfer_original_work_action_ack_read", action_id=action.id, work_item_id=row.id)
    return action_ack(action)


@storage_boundary
def act(db, user, payload):
    payload = validated_payload(TransferWorkActionCreate, payload)
    existing = db.scalar(select(CareTransferWorkAction).where(CareTransferWorkAction.client_action_id == payload.client_action_id))
    digest = canonical_digest(payload.model_dump())
    if existing:
        verify_action(existing)
        if (existing.actor_user_id, existing.patient_id, existing.work_item_id, existing.payload_digest) != (
                user.id, payload.patient_id, payload.work_item_id, digest):
            raise HTTPException(409, "Original work-action ID has a different immutable actor, body or scope.")
        return _recover(db, user, existing), False
    original = open_context("work", payload.action_context, user)
    db.execute(update(CareTransferWorkItem).where(CareTransferWorkItem.id == payload.work_item_id)
        .values(version=CareTransferWorkItem.version).execution_options(synchronize_session=False))
    row = work_row(db, payload.work_item_id)
    basis = read_work_authority(db, user, row, processing=True)
    if row.patient_id != payload.patient_id or payload.expected_version != row.version or payload.action not in allowed(row):
        raise HTTPException(409, "The original work version or permitted transition changed; retain the original action.")
    if (original.get("actor_identity_basis"), original.get("patient_id"), original.get("work_item_id"),
            original.get("expected_version"), original.get("previous_status"), original.get("work_context")) != (
            basis, row.patient_id, row.id, row.version, row.status, metadata(row, WORK_FIELDS)):
        raise HTTPException(409, "The original confirmed work context differs from the actual accepted responsibility.")
    original_authority(db, original.get("authorization_snapshot"))
    action = CareTransferWorkAction(client_action_id=payload.client_action_id, patient_id=row.patient_id, work_item_id=row.id,
        actor_user_id=user.id, actor_identity_basis=basis, action=payload.action, previous_status=row.status,
        status=TARGETS[payload.action], expected_version=row.version, version=row.version + 1,
        occurred_at=datetime.now(timezone.utc), action_context_digest=canonical_digest(payload.action_context),
        payload_digest=digest, authorization_snapshot=original["authorization_snapshot"])
    action.body = {"metadata": metadata(action, ACTION_FIELDS), "reason": payload.reason}
    db.add(action)
    row.status, row.version = action.status, action.version
    row.suspension_reason = None
    row.state_snapshot = work_state(row)
    try:
        db.flush()
        append_care_event(db, patient_id=row.patient_id, actor_user_id=user.id, actor_identity_basis=basis,
            event_type="care_transfer_work_" + action.status, aggregate_type="care_transfer_work", aggregate_id=row.id,
            revision=row.version, dedupe_key="care_transfer_work_action:" + action.client_action_id,
            payload={"work_item_id": row.id, "action_id": action.id, "actual_actor_user_id": user.id,
                "authorization_snapshot": action.authorization_snapshot})
        audit(db, user, row.patient_id, "care_transfer_work_action_committed", work_item_id=row.id,
            action_id=action.id, actual_status=row.status)
        db.flush()
    except IntegrityError as exc:
        raise HTTPException(409, "Concurrent work action; query/retry the unchanged original ID.") from exc
    return action_ack(action), True


@storage_boundary
def original_action(db, user, client_action_id):
    action = db.scalar(select(CareTransferWorkAction).where(CareTransferWorkAction.client_action_id == client_action_id))
    if action is None:
        raise HTTPException(404, "Original successor-work action not found.")
    return _recover(db, user, action, historical=True)


@storage_boundary
def history(db, user, identifier):
    row = work_row(db, identifier)
    read_work_authority(db, user, row)
    items = [action_ack(action) for action in db.scalars(select(CareTransferWorkAction)
        .where(CareTransferWorkAction.work_item_id == row.id).order_by(CareTransferWorkAction.version)).all()]
    audit(db, user, row.patient_id, "care_transfer_work_history_read", work_item_id=row.id)
    return {"work_item_id": row.id, "patient_id": row.patient_id, "items": items}
