"""Actual institutional review scope; all responses follow critical audit commit."""
from fastapi import APIRouter, Depends, Response
from pydantic import Field
from sqlalchemy.orm import Session

from backend.app.api.deps import get_current_user, get_db
from backend.app.api.routes.care import _commit_cycle_response
from backend.app.models.user import User
from backend.app.schemas.service_coverage import ServiceCoverageCreate
from backend.app.services import service_coverage_service as service

router = APIRouter(tags=["service-coverage"])


class CoverageSubmission(ServiceCoverageCreate):
    doctor_user_id: int = Field(gt=0, strict=True)
    configuration_context: str = Field(min_length=20, max_length=65536)


@router.post("/identity/service-coverage-versions", status_code=201)
def submit_original_version(payload: CoverageSubmission, response: Response,
        current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    original = ServiceCoverageCreate.model_validate(payload.model_dump(exclude={"doctor_user_id"}))
    value, created = service.create_coverage(db, current_user, payload.doctor_user_id, original)
    response.status_code = 201 if created else 200
    return _commit_cycle_response(db, value)


@router.get("/identity/service-coverage-submissions/{client_coverage_id}")
def original_version(client_coverage_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, service.original_coverage(db, current_user, client_coverage_id))


@router.get("/identity/service-coverage/doctors")
def reviewable_doctors(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, service.reviewer_doctors(db, current_user))


@router.post("/identity/service-coverage/{doctor_user_id}/versions", status_code=201)
def create_version(doctor_user_id: int, payload: ServiceCoverageCreate, response: Response,
        current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    value, created = service.create_coverage(db, current_user, doctor_user_id, payload)
    response.status_code = 201 if created else 200
    return _commit_cycle_response(db, value)


@router.get("/identity/service-coverage/{doctor_user_id}/versions")
def list_versions(doctor_user_id: int, institution_id: str,
        current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, service.coverage_versions(db, current_user, doctor_user_id, institution_id))


@router.get("/care/doctor/service-coverage")
def current_doctor_coverage(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, service.doctor_coverage(db, current_user))
