from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.app.api.deps import get_db, require_roles
from backend.app.models.patient import Patient
from backend.app.models.security import SecurityPatientAssignment
from backend.app.models.user import User, UserRole, UserSubrole
from backend.app.schemas.security import (
    SecurityAuditLogListResponse,
    SecurityDacPatientListResponse,
    SecurityCipherRecordListResponse,
    SecurityKeyAssignmentListResponse,
    SecurityMcsNodeListResponse,
    SecurityPatientAssignmentListResponse,
    SecurityPatientOverviewResponse,
    SecuritySpatialAuditRequest,
    SecuritySystemStatusResponse,
    SecurityTemporalAuditRequest,
    SecurityTemporalAuditResponse,
)
from backend.app.services.security_service import (
    build_patient_security_overview,
    patient_alias,
    verify_audit_log_chain,
    build_security_status,
    get_security_config,
    initialize_security_system,
    list_key_assignments,
    list_mcs_nodes,
    list_patient_cipher_records,
    list_patient_assignments,
    list_recent_audit_logs,
    list_recent_audits,
    run_temporal_audit,
    run_spatial_audit,
)


router = APIRouter(prefix="/security", tags=["security"])


def _require_dac_user(current_user: User) -> None:
    if (
        current_user.role != UserRole.RESEARCHER
        or current_user.subrole != UserSubrole.DAC
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="DAC permission required.",
        )


@router.get("/system/status", response_model=SecuritySystemStatusResponse)
def get_system_status(
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> SecuritySystemStatusResponse:
    return SecuritySystemStatusResponse(**build_security_status(db))


@router.post("/system/init", response_model=SecuritySystemStatusResponse)
def init_security_system(
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> SecuritySystemStatusResponse:
    _require_dac_user(current_user)
    initialize_security_system(db, current_user)
    return SecuritySystemStatusResponse(**build_security_status(db))


@router.get("/system/key_assignments", response_model=SecurityKeyAssignmentListResponse)
def get_key_assignments(
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> SecurityKeyAssignmentListResponse:
    _require_dac_user(current_user)
    return SecurityKeyAssignmentListResponse(
        items=list_key_assignments(db, current_user)
    )


@router.get("/system/mcs_nodes", response_model=SecurityMcsNodeListResponse)
def get_mcs_nodes(
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> SecurityMcsNodeListResponse:
    _require_dac_user(current_user)
    return SecurityMcsNodeListResponse(items=list_mcs_nodes(db))


@router.get(
    "/system/patient_assignments", response_model=SecurityPatientAssignmentListResponse
)
def get_patient_assignments(
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> SecurityPatientAssignmentListResponse:
    _require_dac_user(current_user)
    return SecurityPatientAssignmentListResponse(
        items=list_patient_assignments(db, current_user)
    )


@router.get(
    "/patient/{patient_id}/overview", response_model=SecurityPatientOverviewResponse
)
def get_patient_security_overview(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> SecurityPatientOverviewResponse:
    _require_patient_access(db, patient_id, current_user)

    return SecurityPatientOverviewResponse(
        **build_patient_security_overview(db, patient_id)
    )


@router.get(
    "/patient/{patient_id}/cipher_records",
    response_model=SecurityCipherRecordListResponse,
)
def get_patient_cipher_records(
    patient_id: int,
    source_type: str | None = None,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> SecurityCipherRecordListResponse:
    _require_patient_access(db, patient_id, current_user)
    return SecurityCipherRecordListResponse(
        items=list_patient_cipher_records(db, patient_id, source_type=source_type)
    )


@router.get("/dac/patients", response_model=SecurityDacPatientListResponse)
def get_dac_patients(
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> SecurityDacPatientListResponse:
    _require_dac_user(current_user)

    assignments = db.scalars(
        select(SecurityPatientAssignment)
        .where(
            SecurityPatientAssignment.assigned_dac_user_id == current_user.id,
            SecurityPatientAssignment.assignment_status == "active",
        )
        .order_by(
            SecurityPatientAssignment.updated_at.desc(),
            SecurityPatientAssignment.id.desc(),
        )
    ).all()
    patients = [db.get(Patient, assignment.patient_id) for assignment in assignments]
    items = [
        {
            "patient_id": patient.id,
            "patient_name": patient_alias(patient.id),
            "patient_alias": patient_alias(patient.id),
            "patient_type": patient.patient_type.value,
            "created_at": patient.created_at.isoformat(),
            "security_overview": build_patient_security_overview(db, patient.id),
        }
        for patient in patients
        if patient is not None
    ]
    return SecurityDacPatientListResponse(total=len(items), items=items)


@router.post("/dac/temporal_audits", response_model=SecurityTemporalAuditResponse)
def create_temporal_audit(
    payload: SecurityTemporalAuditRequest,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> SecurityTemporalAuditResponse:
    _require_dac_user(current_user)

    if get_security_config(db) is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Security system is not initialized yet.",
        )

    try:
        task = run_temporal_audit(
            db,
            patient_id=payload.patient_id,
            source_type=payload.source_type,
            requester=current_user,
            audit_group=payload.audit_group,
        )
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)
        ) from error

    return SecurityTemporalAuditResponse(
        id=task.id,
        patient_id=task.patient_id,
        requested_by_user_id=task.requested_by_user_id,
        patient_assignment_id=task.patient_assignment_id,
        mcs_node_id=task.mcs_node_id,
        task_type=task.task_type,
        source_type=task.source_type,
        status=task.status,
        verification_passed=task.verification_passed,
        verification_details=task.verification_details_json,
        decrypted_stats=task.decrypted_stats_json,
        created_at=task.created_at.isoformat() if task.created_at else None,
        completed_at=task.completed_at.isoformat() if task.completed_at else None,
    )


@router.post("/dac/spatial_audits", response_model=SecurityTemporalAuditResponse)
def create_spatial_audit(
    payload: SecuritySpatialAuditRequest,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> SecurityTemporalAuditResponse:
    _require_dac_user(current_user)

    if get_security_config(db) is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Security system is not initialized yet.",
        )

    try:
        task = run_spatial_audit(
            db,
            patient_ids=payload.patient_ids,
            source_type=payload.source_type,
            requester=current_user,
            audit_group=payload.audit_group,
        )
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)
        ) from error

    return SecurityTemporalAuditResponse(
        id=task.id,
        patient_id=task.patient_id,
        requested_by_user_id=task.requested_by_user_id,
        patient_assignment_id=task.patient_assignment_id,
        mcs_node_id=task.mcs_node_id,
        task_type=task.task_type,
        source_type=task.source_type,
        status=task.status,
        verification_passed=task.verification_passed,
        verification_details=task.verification_details_json,
        decrypted_stats=task.decrypted_stats_json,
        created_at=task.created_at.isoformat() if task.created_at else None,
        completed_at=task.completed_at.isoformat() if task.completed_at else None,
    )


@router.get("/dac/recent_audits", response_model=list[SecurityTemporalAuditResponse])
def get_recent_temporal_audits(
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> list[SecurityTemporalAuditResponse]:
    _require_dac_user(current_user)
    return [
        SecurityTemporalAuditResponse(**item)
        for item in list_recent_audits(db, current_user)
    ]


@router.get("/dac/audit_logs", response_model=SecurityAuditLogListResponse)
def get_recent_logs(
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> SecurityAuditLogListResponse:
    _require_dac_user(current_user)
    return SecurityAuditLogListResponse(items=list_recent_audit_logs(db, current_user))


def _require_patient_access(db: Session, patient_id: int, current_user: User) -> None:
    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="Patient not found.")
    if current_user.subrole == UserSubrole.DAC:
        assignment = db.scalar(
            select(SecurityPatientAssignment).where(
                SecurityPatientAssignment.patient_id == patient_id,
                SecurityPatientAssignment.assigned_dac_user_id == current_user.id,
                SecurityPatientAssignment.assignment_status == "active",
            )
        )
        allowed = assignment is not None
    else:
        allowed = patient.assigned_researcher_id == current_user.id
    if not allowed:
        raise HTTPException(
            status_code=403, detail="Patient access is outside your assignment."
        )


@router.get("/dac/log_chain")
def audit_log_chain(
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> dict:
    _require_dac_user(current_user)
    result = verify_audit_log_chain(db)
    return {
        key: result[key] for key in ("verified", "checked_records", "head_verified")
    }
