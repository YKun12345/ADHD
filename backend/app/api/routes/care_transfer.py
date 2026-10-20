"""Concrete responsibility handover APIs share the critical commit boundary."""
from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from backend.app.api.deps import get_current_user, get_db
from backend.app.api.routes.care import _commit_cycle_response
from backend.app.models.user import User
from backend.app.schemas.care_transfer import TransferPreflight, TransferRequestCreate, TransferDecisionCreate, TransferWorkActionCreate
from backend.app.services import care_transfer_service as service
from backend.app.services import care_transfer_work_service as work

router = APIRouter(prefix="/care", tags=["responsibility-transfer"])


@router.get("/responsibility-transfers/options")
def options(patient_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, service.transfer_options(db, current_user, patient_id))


@router.post("/responsibility-transfers/preflight")
def preflight(payload: TransferPreflight, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, service.request_preflight(db, current_user, payload))


@router.post("/responsibility-transfers", status_code=201)
def create(payload: TransferRequestCreate, response: Response, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    result, created = service.create_request(db, current_user, payload)
    response.status_code = 201 if created else 200
    return _commit_cycle_response(db, result)


@router.get("/responsibility-transfers")
def listed(patient_id: int | None = None, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, service.list_requests(db, current_user, patient_id))


@router.get("/responsibility-transfers/submissions/{client_transfer_id}")
def original_request(client_transfer_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, service.original_request(db, current_user, client_transfer_id))


@router.get("/responsibility-transfers/{transfer_id}")
def detail(transfer_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, service.request_detail(db, current_user, transfer_id))


@router.post("/responsibility-transfer-decisions", status_code=201)
def decide(payload: TransferDecisionCreate, response: Response, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    result, created = service.make_decision(db, current_user, payload)
    response.status_code = 201 if created else 200
    return _commit_cycle_response(db, result)


@router.get("/responsibility-transfer-decisions/{client_decision_id}")
def original_decision(client_decision_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, service.original_decision(db, current_user, client_decision_id))


@router.get("/transferred-work")
def transferred_work(patient_id: int | None = None, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, service.list_work(db, current_user, patient_id))


@router.get("/transferred-work/{work_item_id}")
def work_detail(work_item_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, work.detail(db, current_user, work_item_id))


@router.get("/transferred-work/{work_item_id}/history")
def work_history(work_item_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, work.history(db, current_user, work_item_id))


@router.post("/transferred-work-actions", status_code=201)
def work_action(payload: TransferWorkActionCreate, response: Response, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    result, created = work.act(db, current_user, payload)
    response.status_code = 201 if created else 200
    return _commit_cycle_response(db, result)


@router.get("/transferred-work-actions/{client_action_id}")
def original_work_action(client_action_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, work.original_action(db, current_user, client_action_id))
