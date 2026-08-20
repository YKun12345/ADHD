from pydantic import BaseModel, Field


class SecuritySystemStatusResponse(BaseModel):
    is_initialized: bool
    system_version: str
    storage_mode: str
    public_params: dict = Field(default_factory=dict)
    profiles: dict = Field(default_factory=dict)
    key_assignment_count: int
    mcs_node_count: int = 0
    patient_assignment_count: int = 0
    cipher_record_count: int
    audit_task_count: int
    initialized_at: str | None = None
    updated_at: str | None = None
    initialized_by_user_id: int | None = None


class SecurityKeyAssignmentItem(BaseModel):
    user_id: int
    full_name: str
    email: str
    staff_id: str | None = None
    role: str
    subrole: str | None = None
    patient_id: int | None = None
    key_fingerprint: str | None = None
    key_role: str | None = None
    is_active: bool
    created_at: str | None = None


class SecurityKeyAssignmentListResponse(BaseModel):
    items: list[SecurityKeyAssignmentItem]


class SecurityCipherRecordItem(BaseModel):
    id: int
    patient_id: int
    source_type: str
    source_record_id: int | None = None
    patient_assignment_id: int | None = None
    mcs_node_id: int | None = None
    time_bucket: str
    dimension_labels: list[str]
    metadata: dict = Field(default_factory=dict)
    integrity_digest: str
    cipher_version: str
    created_at: str | None = None


class SecurityCipherRecordListResponse(BaseModel):
    items: list[SecurityCipherRecordItem]


class SecurityTemporalAuditRequest(BaseModel):
    patient_id: int
    source_type: str = Field(pattern="^(tracking|scale|cognitive)$")


class SecuritySpatialAuditRequest(BaseModel):
    patient_ids: list[int] = Field(min_length=1)
    source_type: str = Field(pattern="^(tracking|scale|cognitive)$")


class SecurityTemporalAuditResponse(BaseModel):
    id: int
    patient_id: int
    requested_by_user_id: int | None = None
    patient_assignment_id: int | None = None
    mcs_node_id: int | None = None
    task_type: str
    source_type: str
    status: str
    verification_passed: bool | None = None
    verification_details: dict = Field(default_factory=dict)
    decrypted_stats: dict = Field(default_factory=dict)
    created_at: str | None = None
    completed_at: str | None = None


class SecurityAuditLogItem(BaseModel):
    id: int
    audit_task_id: int | None = None
    patient_id: int | None = None
    actor_user_id: int | None = None
    action: str
    status: str
    message: str
    detail: dict = Field(default_factory=dict)
    created_at: str | None = None


class SecurityAuditLogListResponse(BaseModel):
    items: list[SecurityAuditLogItem]


class SecurityMcsNodeItem(BaseModel):
    id: int
    node_code: str
    node_name: str
    storage_backend: str
    storage_namespace: str
    is_active: bool
    created_at: str | None = None


class SecurityMcsNodeListResponse(BaseModel):
    items: list[SecurityMcsNodeItem]


class SecurityPatientAssignmentItem(BaseModel):
    id: int
    patient_id: int
    patient_name: str | None = None
    patient_user_id: int
    assigned_dac_user_id: int | None = None
    assigned_dac_name: str | None = None
    assigned_mcs_node_id: int | None = None
    assigned_mcs_node_code: str | None = None
    assignment_status: str
    assignment_version: int
    updated_at: str | None = None


class SecurityPatientAssignmentListResponse(BaseModel):
    items: list[SecurityPatientAssignmentItem]


class SecurityPatientOverviewResponse(BaseModel):
    patient_id: int
    security_stage: str
    assignment_status: str | None = None
    assigned_dac_user_id: int | None = None
    assigned_dac_name: str | None = None
    assigned_mcs_node_id: int | None = None
    assigned_mcs_node_code: str | None = None
    assigned_mcs_node_name: str | None = None
    cipher_record_count: int = 0
    has_cipher_records: bool = False
    cipher_source_counts: dict = Field(default_factory=dict)
    latest_temporal_audit_id: int | None = None
    latest_temporal_audit_status: str | None = None
    latest_temporal_audit_passed: bool | None = None
    latest_temporal_audit_source_type: str | None = None
    latest_temporal_audit_completed_at: str | None = None
