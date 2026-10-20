"""Actual user proposals and actual doctor acceptance, in caller-owned transactions."""
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from backend.app.models.attention import AttentionItem
from backend.app.models.care_transfer import (CareTransferRequest, CareTransferDecision, CareTransferWorkItem, CareTransferClaim)
from backend.app.models.identity import CareRelationship
from backend.app.models.user import User
from backend.app.schemas.care_transfer import TransferPreflight, TransferRequestCreate, TransferDecisionCreate
from backend.app.services.assessment_service import authorization_snapshot
from backend.app.services.attention_service import set_attention_state
from backend.app.services.care_transfer_access import (REQUEST_FIELDS, DECISION_FIELDS, WORK_FIELDS, FINAL_STATUS,
    metadata, own, receiver_scope, original_authority, save_authority, restore_authority,
    issue_context, open_context, verify_request, request_row, verify_decision, verify_work, source_info,
    read_request_authority, read_work_authority, request_ack, decision_ack, work_response, work_state, audit, storage_boundary, validated_payload)
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.event_service import append_care_event
from backend.app.services.identity_access import require_doctor, self_access
from backend.app.services.service_coverage_service import current_coverage, working_deadline


def _selected(payload):
    return [{"source_type": item.source_type, "source_id": item.source_id, "expected_version": item.expected_version}
        for item in payload.sources]


def _sources(db, payload, *, allow_claim=None):
    values = []
    for item in payload.sources:
        value = source_info(db, item.source_type, item.source_id, payload.patient_id)
        if value["expected_version"] != item.expected_version:
            raise HTTPException(409, "A selected source changed; the actual user must reconfirm the new object list.")
        if value["claimed_transfer_id"] is not None and value["claimed_transfer_id"] != allow_claim:
            raise HTTPException(409, "This source already has a pending handover; read that original request first.")
        values.append(value)
    return values


def _lock_sources(db, sources):
    for source in sorted(sources, key=lambda value: (value["source_type"], value["source_id"])):
        model = AttentionItem if source["source_type"] == "attention" else CareTransferWorkItem
        db.execute(update(model).where(model.id == source["source_id"]).values(version=model.version)
            .execution_options(synchronize_session=False))


def _event(db, user, patient_id, basis, event_type, aggregate, identifier, version, payload, key):
    append_care_event(db, patient_id=patient_id, actor_user_id=user.id, actor_identity_basis=basis,
        event_type=event_type, aggregate_type=aggregate, aggregate_id=identifier, revision=version,
        payload=payload, dedupe_key=key)


@storage_boundary
def transfer_options(db, user, patient_id):
    own(db, user, patient_id)
    sources = []
    for kind, model in (("attention", AttentionItem), ("transferred_work", CareTransferWorkItem)):
        rows = db.scalars(select(model).where(model.patient_id == patient_id).order_by(model.id)).all()
        for row in rows:
            if kind == "attention" and row.owner_kind != "doctor":
                continue
            try:
                value = source_info(db, kind, row.id, patient_id)
                if value["claimed_transfer_id"] is None:
                    sources.append(value)
            except HTTPException as exc:
                if exc.status_code != 409:
                    raise
    relationships = []
    for relation in db.scalars(select(CareRelationship).where(CareRelationship.patient_id == patient_id,
            CareRelationship.status == "active", CareRelationship.purpose == "clinical_sharing").order_by(CareRelationship.id)).all():
        saved = save_authority(db)
        try:
            actual, _ = receiver_scope(db, patient_id, relation.id, processing=False)
            relationships.append({"relationship_id": actual.id, "relationship_revision": actual.revision,
                "doctor_user_id": actual.doctor_user_id, "institution_id": actual.institution_id,
                "doctor_name": db.get(User, actual.doctor_user_id).full_name})
        except HTTPException as exc:
            if exc.status_code not in {403, 409}:
                raise
        finally:
            restore_authority(db, saved)
    audit(db, user, patient_id, "care_transfer_options_read", source_count=len(sources), receiver_count=len(relationships))
    return {"patient_id": patient_id, "sources": sources, "receiving_relationships": relationships,
        "scope": "selected_clinical_attention_only", "old_assessments_and_plans_are_not_resumed": True}


@storage_boundary
def request_preflight(db, user, payload):
    payload = validated_payload(TransferPreflight, payload)
    basis = own(db, user, payload.patient_id, processing=True)
    relation, _ = receiver_scope(db, payload.patient_id, payload.receiving_relationship_id, processing=True)
    if relation.patient_actor_user_id != user.id:
        raise HTTPException(403, "The actual current patient identity must confirm its own receiving relationship.")
    sources = _sources(db, payload)
    if any(source["from_doctor_user_id"] == relation.doctor_user_id for source in sources):
        raise HTTPException(409, "Select an actual new receiving doctor for this handover.")
    value = {"actor_user_id": user.id, "actor_identity_basis": basis, "patient_id": payload.patient_id,
        "receiving_relationship_id": relation.id, "receiving_relationship_revision": relation.revision,
        "receiver_doctor_user_id": relation.doctor_user_id, "selected": _selected(payload), "sources": sources,
        "reason": payload.reason, "authorization_snapshot": authorization_snapshot(db)}
    token = issue_context("request", value)
    audit(db, user, payload.patient_id, "care_transfer_request_preflight_read", receiving_relationship_id=relation.id,
        sources_digest=canonical_digest(sources))
    return {**value, "request_context": token, "request_context_digest": canonical_digest(token)}


@storage_boundary
def create_request(db, user, payload):
    payload = validated_payload(TransferRequestCreate, payload)
    existing = db.scalar(select(CareTransferRequest).where(CareTransferRequest.client_transfer_id == payload.client_transfer_id))
    digest = canonical_digest(payload.model_dump())
    if existing:
        verify_request(existing)
        if (existing.author_user_id, existing.patient_id, existing.payload_digest) != (user.id, payload.patient_id, digest):
            raise HTTPException(409, "This original request ID has a different immutable actor, body or scope.")
        own(db, user, existing.patient_id, processing=True)
        original_authority(db, existing.authorization_snapshot)
        audit(db, user, existing.patient_id, "care_transfer_original_request_ack_read", transfer_id=existing.id)
        return request_ack(existing), False
    original = open_context("request", payload.request_context, user)
    basis = own(db, user, payload.patient_id, processing=True)
    relation, _ = receiver_scope(db, payload.patient_id, payload.receiving_relationship_id, processing=True)
    _lock_sources(db, _selected(payload))
    sources = _sources(db, payload)
    if (original.get("actor_identity_basis"), original.get("patient_id"), original.get("receiving_relationship_id"),
            original.get("receiving_relationship_revision"), original.get("receiver_doctor_user_id"),
            original.get("selected"), original.get("sources"), original.get("reason")) != (
            basis, payload.patient_id, relation.id, relation.revision, relation.doctor_user_id,
            _selected(payload), sources, payload.reason) or relation.patient_actor_user_id != user.id:
        raise HTTPException(409, "The original user-confirmed source list or actual recipient changed.")
    original_authority(db, original.get("authorization_snapshot"))
    row = CareTransferRequest(client_transfer_id=payload.client_transfer_id, patient_id=payload.patient_id,
        author_user_id=user.id, author_identity_basis=basis, receiver_doctor_user_id=relation.doctor_user_id,
        receiving_relationship_id=relation.id, requested_at=datetime.now(timezone.utc), version=1,
        request_context_digest=canonical_digest(payload.request_context), payload_digest=digest,
        authorization_snapshot=original["authorization_snapshot"])
    row.body = {"metadata": metadata(row, REQUEST_FIELDS), "sources": sources, "reason": payload.reason,
        "selected": _selected(payload)}
    db.add(row)
    try:
        db.flush()
        for source in sources:
            claim = db.get(CareTransferClaim, (source["source_type"], source["source_id"]), with_for_update=True)
            if claim is None:
                claim = CareTransferClaim(source_type=source["source_type"], source_id=source["source_id"], patient_id=row.patient_id,
                    transfer_id=row.id, revision=1)
                db.add(claim)
            else:
                if claim.transfer_id is not None or claim.revision != source["claim_revision"]:
                    raise HTTPException(409, "A concurrent source claim changed; keep the original request unchanged.")
                claim.transfer_id = row.id
                claim.revision += 1
        _event(db, user, row.patient_id, basis, "care_transfer_requested", "care_transfer_request", row.id, 1,
            {"transfer_id": row.id, "receiver_doctor_user_id": row.receiver_doctor_user_id, "sources_digest": canonical_digest(sources),
                "authorization_snapshot": row.authorization_snapshot}, "care_transfer_request:" + row.client_transfer_id)
        audit(db, user, row.patient_id, "care_transfer_requested", transfer_id=row.id, request_context_digest=row.request_context_digest)
        db.flush()
    except IntegrityError as exc:
        raise HTTPException(409, "Concurrent handover request; query or retry its original unchanged ID.") from exc
    return request_ack(row), True


@storage_boundary
def original_request(db, user, client_transfer_id):
    row = db.scalar(select(CareTransferRequest).where(CareTransferRequest.client_transfer_id == client_transfer_id))
    if row is None:
        raise HTTPException(404, "Original handover request not found.")
    verify_request(row)
    if row.author_user_id != user.id:
        raise HTTPException(403, "Only the actual original author can recover this original request ACK.")
    # The immutable creation ACK is already visible in this lawful owner's
    # history. Querying it is no new processing and cannot reactivate anything.
    own(db, user, row.patient_id)
    audit(db, user, row.patient_id, "care_transfer_original_request_ack_read", transfer_id=row.id)
    return request_ack(row)


def _current_sources_for_acceptance(db, row):
    stored = verify_request(row)["sources"]
    for before in stored:
        current = source_info(db, before["source_type"], before["source_id"], row.patient_id)
        expected = {**before, "claim_revision": before["claim_revision"] + 1, "claimed_transfer_id": row.id}
        if current != expected:
            raise HTTPException(409, "A source changed after user authorization; the user must reconfirm the actual new list.")
    return stored


def _decision_scope(db, user, row, decision):
    if decision == "cancel":
        return own(db, user, row.patient_id)
    if user.id != row.receiver_doctor_user_id:
        raise HTTPException(403, "Only the actual receiving doctor can accept or reject this request.")
    _, basis = receiver_scope(db, row.patient_id, row.receiving_relationship_id, processing=True, expected_doctor=user.id)
    original_authority(db, row.authorization_snapshot)
    return basis


@storage_boundary
def request_detail(db, user, transfer_id):
    row = request_row(db, transfer_id)
    read_request_authority(db, user, row)
    decision = db.scalar(select(CareTransferDecision).where(CareTransferDecision.transfer_id == row.id))
    actions, token = [], None
    if decision is None:
        saved = save_authority(db)
        try:
            if self_access(db, user.id, row.patient_id):
                basis = _decision_scope(db, user, row, "cancel")
                actions = ["cancel"]
            else:
                basis = _decision_scope(db, user, row, "accept")
                actions = ["reject"]
                try:
                    _current_sources_for_acceptance(db, row)
                    actions.insert(0, "accept")
                except HTTPException as exc:
                    if exc.status_code != 409:
                        raise
            token = issue_context("decision", {"actor_user_id": user.id, "actor_identity_basis": basis,
                "patient_id": row.patient_id, "transfer_id": row.id, "expected_version": 1,
                "request_payload_digest": row.payload_digest, "allowed_decisions": actions,
                "source_count": len(row.body["sources"]),
                "authorization_snapshot": authorization_snapshot(db)})
        except HTTPException as exc:
            if exc.status_code not in {403, 409}:
                raise
            restore_authority(db, saved)
    status = FINAL_STATUS[decision.decision] if decision else "pending_acceptance"
    result = {"request": request_ack(row), "status": status, "version": 2 if decision else 1,
        "decision": decision_ack(db, decision) if decision else None, "allowed_actions": actions,
        "decision_context": token, "decision_context_digest": canonical_digest(token) if token else None}
    audit(db, user, row.patient_id, "care_transfer_detail_read", transfer_id=row.id)
    return result


def _pause_selected_source(db, source):
    if source["source_type"] == "attention":
        row = db.get(AttentionItem, source["source_id"], populate_existing=True)
        set_attention_state(row, "suspended", "responsibility_transferred")
    else:
        row = db.get(CareTransferWorkItem, source["source_id"], populate_existing=True)
        verify_work(db, row)
        row.status = "suspended"
        row.suspension_reason = "responsibility_transferred"
        row.version += 1
        row.state_snapshot = work_state(row)


@storage_boundary
def make_decision(db, user, payload):
    payload = validated_payload(TransferDecisionCreate, payload)
    digest = canonical_digest(payload.model_dump())
    existing = db.scalar(select(CareTransferDecision).where(CareTransferDecision.client_decision_id == payload.client_decision_id))
    if existing:
        verify_decision(existing)
        if (existing.actor_user_id, existing.transfer_id, existing.patient_id, existing.payload_digest) != (user.id, payload.transfer_id, payload.patient_id, digest):
            raise HTTPException(409, "This original decision ID belongs to another immutable actor, scope or body.")
        request = request_row(db, existing.transfer_id)
        _decision_scope(db, user, request, existing.decision)
        original_authority(db, existing.authorization_snapshot)
        audit(db, user, request.patient_id, "care_transfer_original_decision_ack_read", decision_id=existing.id)
        return decision_ack(db, existing), False
    db.execute(update(CareTransferRequest).where(CareTransferRequest.id == payload.transfer_id)
        .values(version=CareTransferRequest.version).execution_options(synchronize_session=False))
    row = request_row(db, payload.transfer_id)
    if row.patient_id != payload.patient_id or payload.expected_version != 1:
        raise HTTPException(409, "The decision must retain the actual original patient and request version.")
    if db.scalar(select(CareTransferDecision.id).where(CareTransferDecision.transfer_id == row.id)) is not None:
        raise HTTPException(409, "This handover already has a final actual decision.")
    original = open_context("decision", payload.decision_context, user)
    basis = _decision_scope(db, user, row, payload.decision)
    if (original.get("actor_identity_basis"), original.get("patient_id"), original.get("transfer_id"),
            original.get("expected_version"), original.get("request_payload_digest")) != (basis, row.patient_id, row.id, 1, row.payload_digest) or payload.decision not in original.get("allowed_decisions", []):
        raise HTTPException(409, "The original confirmed decision scope or request changed.")
    original_authority(db, original.get("authorization_snapshot"))
    sources = verify_request(row)["sources"]
    _lock_sources(db, sources)
    if payload.decision == "accept":
        _current_sources_for_acceptance(db, row)
    decision = CareTransferDecision(client_decision_id=payload.client_decision_id, patient_id=row.patient_id, transfer_id=row.id,
        actor_user_id=user.id, actor_identity_basis=basis, decision=payload.decision, expected_version=1, version=2,
        confirmed=True, decided_at=datetime.now(timezone.utc), decision_context_digest=canonical_digest(payload.decision_context),
        payload_digest=digest, authorization_snapshot=original["authorization_snapshot"])
    decision.body = {"metadata": metadata(decision, DECISION_FIELDS), "reason": payload.reason}
    db.add(decision)
    try:
        db.flush()
        coverage = current_coverage(db, row.receiver_doctor_user_id, at=decision.decided_at) if payload.decision == "accept" else None
        for source in sources:
            claim = db.get(CareTransferClaim, (source["source_type"], source["source_id"]), with_for_update=True)
            if claim is None or claim.patient_id != row.patient_id or claim.transfer_id != row.id or claim.revision != source["claim_revision"] + 1:
                raise HTTPException(409, "The concrete source claim changed before the final decision.")
            if payload.decision != "accept":
                claim.transfer_id = None
                claim.revision += 1
                continue
            _pause_selected_source(db, source)
            deadline = working_deadline(decision.decided_at, coverage["coverage"]["working_periods"], coverage["coverage"]["expected_response_working_minutes"]) if coverage["status"] == "configured" else None
            item = CareTransferWorkItem(patient_id=row.patient_id, transfer_id=row.id, decision_id=decision.id,
                source_type=source["source_type"], source_id=source["source_id"], original_attention_id=source["original_attention_id"],
                assessment_id=source["assessment_id"], from_doctor_user_id=source["from_doctor_user_id"],
                responsible_doctor_id=row.receiver_doctor_user_id, receiving_relationship_id=row.receiving_relationship_id,
                accepted_at=decision.decided_at, expected_response_at=deadline, authorization_snapshot=decision.authorization_snapshot,
                status="open", version=1, suspension_reason=None)
            item.detail = {"context_snapshot": metadata(item, WORK_FIELDS), "source_snapshot": source, "response_coverage": coverage}
            item.state_snapshot = work_state(item)
            db.add(item)
        db.flush()
        work_ids = db.scalars(select(CareTransferWorkItem.id).where(CareTransferWorkItem.decision_id == decision.id).order_by(CareTransferWorkItem.id)).all()
        _event(db, user, row.patient_id, basis, "care_transfer_" + FINAL_STATUS[decision.decision], "care_transfer_decision", decision.id, 2,
            {"transfer_id": row.id, "decision_id": decision.id, "work_item_ids": list(work_ids),
                "authorization_snapshot": decision.authorization_snapshot}, "care_transfer_decision:" + decision.client_decision_id)
        audit(db, user, row.patient_id, "care_transfer_decision_committed", transfer_id=row.id, decision_id=decision.id,
            decision=decision.decision, actual_work_item_ids=list(work_ids))
    except IntegrityError as exc:
        raise HTTPException(409, "A concurrent final decision requires original-ID query or unchanged retry.") from exc
    return decision_ack(db, decision), True


@storage_boundary
def list_work(db, user, patient_id=None):
    if patient_id is None:
        require_doctor(db, user.id)
        query = select(CareTransferWorkItem).where(CareTransferWorkItem.responsible_doctor_id == user.id)
    else:
        own(db, user, patient_id)
        query = select(CareTransferWorkItem).where(CareTransferWorkItem.patient_id == patient_id)
    items = []
    for row in db.scalars(query.order_by(CareTransferWorkItem.id)).all():
        saved = save_authority(db)
        try:
            read_work_authority(db, user, row)
            items.append(work_response(db, row))
        except HTTPException as exc:
            if exc.status_code not in {403, 409}:
                raise
            restore_authority(db, saved)
    audit(db, user, patient_id, "care_transfer_work_list_read", work_count=len(items))
    return {"items": items, "scope_status": "actual_accepted_responsibility_and_current_sharing"}


@storage_boundary
def list_requests(db, user, patient_id=None):
    if patient_id is None:
        require_doctor(db, user.id)
        query = select(CareTransferRequest).where(CareTransferRequest.receiver_doctor_user_id == user.id)
    else:
        own(db, user, patient_id)
        query = select(CareTransferRequest).where(CareTransferRequest.patient_id == patient_id)
    items = []
    for row in db.scalars(query.order_by(CareTransferRequest.id.desc())).all():
        saved = save_authority(db)
        try:
            read_request_authority(db, user, row)
            value = request_ack(row)
            decision = db.scalar(select(CareTransferDecision).where(CareTransferDecision.transfer_id == row.id))
            if decision:
                verify_decision(decision)
            items.append({"request": value, "status": FINAL_STATUS[decision.decision] if decision else "pending_acceptance",
                "version": 2 if decision else 1})
        except HTTPException as exc:
            if exc.status_code not in {403, 409}:
                raise
            restore_authority(db, saved)
    audit(db, user, patient_id, "care_transfer_requests_read", request_count=len(items))
    return {"items": items, "scope_status": "lawful_identity_or_actual_addressed_doctor"}


@storage_boundary
def original_decision(db, user, client_decision_id):
    row = db.scalar(select(CareTransferDecision).where(CareTransferDecision.client_decision_id == client_decision_id))
    if row is None:
        raise HTTPException(404, "Original handover decision not found.")
    verify_decision(row)
    if row.actor_user_id != user.id:
        raise HTTPException(403, "Only the actual original decider may recover that original decision ACK.")
    request = request_row(db, row.transfer_id)
    read_request_authority(db, user, request)
    if row.decision != "cancel":
        from backend.app.services.care_transfer_access import original_historical_authority
        original_historical_authority(db, row.authorization_snapshot)
    audit(db, user, row.patient_id, "care_transfer_original_decision_ack_read", decision_id=row.id)
    return decision_ack(db, row)
