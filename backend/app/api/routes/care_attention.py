"""Committed attention actions, with a fixed route for durable original queues."""
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import Field
from sqlalchemy.orm import Session

from backend.app.api.deps import get_current_user, get_db
from backend.app.api.routes.care import _commit_cycle_response
from backend.app.models.user import User
from backend.app.schemas.attention_action import AttentionActionCreate
from backend.app.services import attention_action_service


router = APIRouter(prefix="/care", tags=["care"])


class AttentionActionSubmission(AttentionActionCreate):
    patient_id: int = Field(gt=0, strict=True)
    attention_id: int = Field(gt=0, strict=True)


@router.get("/attention/{attention_id}")
def get_attention_detail(attention_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, attention_action_service.attention_detail(db, current_user, attention_id))


@router.get("/attention/{attention_id}/history")
def get_attention_history(attention_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, attention_action_service.attention_history(db, current_user, attention_id))


@router.get("/attention-actions/{client_action_id}")
def get_original_attention_action(client_action_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, attention_action_service.query_attention_action(db, current_user, client_action_id))


@router.post("/attention/{attention_id}/actions", status_code=201)
def create_attention_action(attention_id: int, payload: AttentionActionCreate, response: Response,
        current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    result, created = attention_action_service.act_on_attention(db, current_user, attention_id, payload)
    response.status_code = 201 if created else 200
    return _commit_cycle_response(db, result)


@router.post("/attention-actions", status_code=201)
def submit_original_attention_action(payload: AttentionActionSubmission, response: Response,
        current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    original = AttentionActionCreate.model_validate(payload.model_dump(exclude={"patient_id", "attention_id"}))
    result, created = attention_action_service.act_on_attention(db, current_user, payload.attention_id, original)
    if result["patient_id"] != payload.patient_id:
        # get_db rolls the whole transaction back. A client field never rebinds a fact.
        raise HTTPException(409, "The original attention belongs to another patient context.")
    response.status_code = 201 if created else 200
    return _commit_cycle_response(db, result)
