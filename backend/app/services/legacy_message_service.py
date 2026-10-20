"""Read-only compatibility for patient-only legacy messages and scoped summaries.

Unknown original relationships cannot be reconstructed from today's grants.
All results are provisional until the caller commits their critical audit.
"""
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.models.care_message import CareMessage
from backend.app.models.shared_message import SharedCareMessage, SharedMessageRead
from backend.app.services import care_message_service as shared
from backend.app.services.identity_access import require_patient_access, self_access


def own_history(db, user, patient_id):
    db.info["requires_basic_use"] = False
    if not self_access(db,user.id,patient_id):
        raise HTTPException(403,"Current self or verified guardian authority is required for own legacy history.")
    require_patient_access(db,user,patient_id,"care")
    rows = db.scalars(select(CareMessage).where(CareMessage.patient_id == patient_id)
        .order_by(CareMessage.created_at,CareMessage.id)).all()
    shared._audit(db,user,patient_id,"legacy_messages_read",legacy_scope_status="own_history_only",
        message_ids=[row.id for row in rows])
    return rows


def unavailable_doctor_history(db, user, patient_id):
    db.info["requires_basic_use"] = False
    require_patient_access(db,user,patient_id,"care")
    # Deliberately no CareMessage query: even sender identity does not establish
    # the missing original relationship revision and original consent receipts.
    shared._audit(db,user,patient_id,"legacy_messages_scope_unverified",
        legacy_scope_status="unverified_relationship")
    return {"items":[],"legacy_scope_status":"unverified_relationship"}


def _authority_state(db):
    return (list(db.info.get("authorization_receipts",[])),
        list(db.info.get("credential_receipts",[])),db.info.get("requires_basic_use",False))


def _restore_authority(db, state):
    receipts, credentials, processing = state
    shared._merge_receipts(db,receipts)
    db.info["credential_receipts"] = credentials
    db.info["requires_basic_use"] = processing
    request = db.info.get("authorization_request")
    if request is not None:
        request.state.credential_receipts = credentials


def scoped_unread_count(db, user, patient_id):
    db.info["requires_basic_use"] = False
    require_patient_access(db,user,patient_id,"care")
    own = bool(self_access(db,user.id,patient_id))
    query = select(SharedCareMessage).where(SharedCareMessage.patient_id == patient_id)
    if not own:
        query = query.where(SharedCareMessage.doctor_user_id == user.id)
    rows = db.scalars(query.order_by(SharedCareMessage.id)
        .execution_options(populate_existing=True)).all()
    unread = 0
    accessible_ids = []
    for row in rows:
        # Integrity failures must never be classified as an inaccessible row.
        shared._verify(row)
        previous = _authority_state(db)
        try:
            shared._read_authority(db,user,row)
        except HTTPException as exc:
            _restore_authority(db,previous)
            if exc.status_code in {403,409}:
                continue
            raise
        accessible_ids.append(row.id)
        receipt = db.scalar(select(SharedMessageRead).where(SharedMessageRead.message_id == row.id,
            SharedMessageRead.viewer_user_id == user.id).execution_options(populate_existing=True))
        if receipt is not None:
            shared._verify(receipt)
        if row.sender_user_id != user.id and receipt is None:
            unread += 1
    shared._audit(db,user,patient_id,"care_shared_message_summary_read",message_ids=accessible_ids,
        viewer_user_id=user.id,unread_message_count=unread,
        unread_message_scope="accessible_shared_messages_actual_viewer")
    return unread
