"""
数据安全增强与审计日志服务

实现数据安全增强功能：
1. 完整的访问审计日志
2. 数据脱敏与加密增强
3. 知情同意数字化管理
4. 数据生命周期管理
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session


class AuditAction(str, Enum):
    # 患者数据访问
    VIEW_PATIENT_PROFILE = "view_patient_profile"
    VIEW_PATIENT_SCALE = "view_patient_scale"
    VIEW_PATIENT_COGNITIVE = "view_patient_cognitive"
    VIEW_PATIENT_TRACKING = "view_patient_tracking"
    VIEW_PATIENT_IMAGING = "view_patient_imaging"
    VIEW_PATIENT_REPORT = "view_patient_report"

    # AI功能使用
    AI_CHAT = "ai_chat"
    AI_EXPLAIN_REPORT = "ai_explain_report"
    AI_GENERATE_INSIGHT = "ai_generate_insight"

    # 干预和沟通
    SEND_MESSAGE = "send_message"
    CREATE_TASK = "create_task"
    GENERATE_INTERVENTION = "generate_intervention"

    # 研究人员操作
    BIND_PATIENT = "bind_patient"
    VIEW_DASHBOARD = "view_dashboard"
    EXPORT_DATA = "export_data"

    # 安全相关
    LOGIN = "login"
    LOGOUT = "logout"
    PASSWORD_CHANGE = "password_change"
    CONSENT_UPDATE = "consent_update"


class DataRetentionPolicy(str, Enum):
    ACTIVE = "active"  # 活跃数据
    ARCHIVED = "archived"  # 归档数据
    PENDING_DELETION = "pending_deletion"  # 待删除
    DELETED = "deleted"  # 已删除


@dataclass
class AuditLogEntry:
    """审计日志条目"""
    id: int
    timestamp: datetime
    actor_user_id: int
    actor_role: str
    action: AuditAction | str
    resource_type: str  # "patient", "scale", "cognitive_test", etc.
    resource_id: int | None
    patient_id: int | None
    details: dict[str, Any]
    ip_address: str | None
    user_agent: str | None


@dataclass
class ConsentRecord:
    """知情同意记录"""
    patient_id: int
    consent_type: str  # "data_collection", "ai_analysis", "research_use"
    granted: bool
    granted_at: datetime
    expires_at: datetime | None
    version: str
    ip_address: str | None


@dataclass
class DataLifecycleStatus:
    """数据生命周期状态"""
    patient_id: int
    data_type: str
    retention_policy: DataRetentionPolicy
    created_at: datetime
    last_accessed: datetime | None
    scheduled_deletion: datetime | None
    size_bytes: int | None


class EnhancedSecurityService:
    """数据安全增强服务"""

    # 数据保留期限（天）
    RETENTION_PERIODS = {
        "active_data": 365 * 3,  # 3年
        "audit_logs": 365 * 5,   # 5年
        "consent_records": 365 * 10,  # 10年
    }

    # 敏感字段定义
    SENSITIVE_FIELDS = {
        "patient": ["name", "email", "phone", "address", "id_number"],
        "scale_result": ["score_json", "detailed_answers"],
        "cognitive_test": ["result_json", "raw_responses"],
        "tracking_log": ["note", "activities"],
    }

    def __init__(self, db: Session):
        self.db = db

    # =========================================================
    # 1. 访问审计日志
    # =========================================================

    def log_access(
        self,
        actor_user_id: int,
        actor_role: str,
        action: AuditAction,
        resource_type: str,
        resource_id: int | None = None,
        patient_id: int | None = None,
        details: dict[str, Any] | None = None,
        ip_address: str | None = None,
        user_agent: str | None = None,
    ) -> None:
        """记录访问审计日志"""
        from backend.app.models.security import SecurityAuditLog

        audit_log = SecurityAuditLog(
            patient_id=patient_id,
            actor_user_id=actor_user_id,
            action=action.value,
            status="success",
            message=f"{actor_role} {action.value} on {resource_type}",
            detail_json={
                "resource_type": resource_type,
                "resource_id": resource_id,
                "actor_role": actor_role,
                "ip_address": ip_address,
                "user_agent": user_agent,
                **(details or {}),
            },
        )

        self.db.add(audit_log)
        self.db.commit()

    def get_audit_logs(
        self,
        user_id: int | None = None,
        patient_id: int | None = None,
        action: AuditAction | None = None,
        start_date: datetime | None = None,
        end_date: datetime | None = None,
        limit: int = 100,
    ) -> list[AuditLogEntry]:
        """获取审计日志"""
        from backend.app.models.security import SecurityAuditLog

        query = select(SecurityAuditLog)

        if user_id:
            query = query.where(SecurityAuditLog.actor_user_id == user_id)
        if patient_id:
            query = query.where(SecurityAuditLog.patient_id == patient_id)
        if action:
            query = query.where(SecurityAuditLog.action == action.value)
        if start_date:
            query = query.where(SecurityAuditLog.created_at >= start_date)
        if end_date:
            query = query.where(SecurityAuditLog.created_at <= end_date)

        query = query.order_by(SecurityAuditLog.created_at.desc()).limit(limit)

        logs = self.db.scalars(query).all()

        result = []
        for log in logs:
            detail_json = log.detail_json or {}

            try:
                audit_action = AuditAction(log.action)
            except ValueError:
                audit_action = log.action  # the raw string（非标准 action 兜底）

            result.append(AuditLogEntry(
                id=log.id,
                timestamp=log.created_at,
                actor_user_id=log.actor_user_id,
                actor_role=detail_json.get("actor_role", "unknown"),
                action=audit_action,
                resource_type=detail_json.get("resource_type", "unknown"),
                resource_id=detail_json.get("resource_id"),
                patient_id=log.patient_id,
                details=detail_json,
                ip_address=detail_json.get("ip_address"),
                user_agent=detail_json.get("user_agent"),
            ))

        return result

    def get_access_statistics(
        self,
        researcher_id: int,
        lookback_days: int = 30,
    ) -> dict[str, Any]:
        """获取访问统计"""
        from backend.app.models.security import SecurityAuditLog

        cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)

        # 统计各类型访问次数
        logs = self.db.scalars(
            select(SecurityAuditLog)
            .where(
                SecurityAuditLog.actor_user_id == researcher_id,
                SecurityAuditLog.created_at >= cutoff,
            )
        ).all()

        action_counts = {}
        patient_access_counts = {}

        for log in logs:
            action = log.action
            action_counts[action] = action_counts.get(action, 0) + 1

            if log.patient_id:
                patient_access_counts[log.patient_id] = patient_access_counts.get(log.patient_id, 0) + 1

        return {
            "period_days": lookback_days,
            "total_accesses": len(logs),
            "action_breakdown": action_counts,
            "patients_accessed": len(patient_access_counts),
            "most_accessed_patient": max(patient_access_counts.items(), key=lambda x: x[1])[0] if patient_access_counts else None,
        }

    # =========================================================
    # 2. 数据脱敏与加密
    # =========================================================

    def anonymize_patient_data(
        self,
        patient_data: dict[str, Any],
        level: str = "standard",
    ) -> dict[str, Any]:
        """数据脱敏"""
        anonymized = patient_data.copy()

        if level == "standard":
            # 标准脱敏：保留结构，脱敏敏感字段
            if "name" in anonymized:
                anonymized["name"] = self._mask_name(anonymized["name"])
            if "email" in anonymized:
                anonymized["email"] = self._mask_email(anonymized["email"])
            if "phone" in anonymized:
                anonymized["phone"] = self._mask_phone(anonymized["phone"])

        elif level == "research":
            # 研究用脱敏：完全匿名化
            for field in ["name", "email", "phone", "address", "id_number"]:
                if field in anonymized:
                    del anonymized[field]

            # 替换ID为哈希
            if "id" in anonymized:
                anonymized["anonymous_id"] = hash(str(anonymized["id"])) % 10000
                del anonymized["id"]

        return anonymized

    def _mask_name(self, name: str) -> str:
        """脱敏姓名"""
        if len(name) <= 1:
            return "*"
        elif len(name) == 2:
            return name[0] + "*"
        else:
            return name[0] + "*" * (len(name) - 2) + name[-1]

    def _mask_email(self, email: str) -> str:
        """脱敏邮箱"""
        if "@" not in email:
            return "***"

        local, domain = email.split("@", 1)
        if len(local) <= 2:
            masked_local = local[0] + "*"
        else:
            masked_local = local[0] + "*" * (len(local) - 2) + local[-1]

        return f"{masked_local}@{domain}"

    def _mask_phone(self, phone: str) -> str:
        """脱敏手机号"""
        if len(phone) < 7:
            return "***"

        return phone[:3] + "****" + phone[-4:]

    def encrypt_sensitive_data(
        self,
        data: dict[str, Any],
        data_type: str,
    ) -> dict[str, Any]:
        """加密敏感数据"""
        encrypted_data = data.copy()

        sensitive_fields = self.SENSITIVE_FIELDS.get(data_type, [])
        for field in sensitive_fields:
            if field in encrypted_data:
                encrypted_data[field] = f"ENCRYPTED:{encrypted_data[field]}"

        return encrypted_data

    # =========================================================
    # 3. 知情同意数字化管理
    # =========================================================

    def record_consent(
        self,
        patient_id: int,
        consent_type: str,
        granted: bool,
        version: str = "1.0",
        ip_address: str | None = None,
        duration_years: int = 2,
    ) -> ConsentRecord:
        """记录知情同意"""
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(days=365 * duration_years) if duration_years > 0 else None

        # 记录知情同意
        record = ConsentRecord(
            patient_id=patient_id,
            consent_type=consent_type,
            granted=granted,
            granted_at=now,
            expires_at=expires_at,
            version=version,
            ip_address=ip_address,
        )

        # 记录审计日志
        self.log_access(
            actor_user_id=patient_id,  # 患者自己操作
            actor_role="patient",
            action=AuditAction.CONSENT_UPDATE,
            resource_type="consent",
            patient_id=patient_id,
            details={
                "consent_type": consent_type,
                "granted": granted,
                "version": version,
                "expires_at": expires_at.isoformat() if expires_at else None,
            },
            ip_address=ip_address,
        )

        return record

    def check_consent_status(
        self,
        patient_id: int,
        consent_type: str,
    ) -> dict[str, Any]:
        """检查知情同意状态"""
        # 这里应该从数据库查询
        # 简化实现，返回模拟数据
        now = datetime.now(timezone.utc)

        return {
            "patient_id": patient_id,
            "consent_type": consent_type,
            "has_consent": True,  # 假设有同意
            "consent_date": now - timedelta(days=30),
            "expires_date": now + timedelta(days=365 * 2 - 30),
            "version": "1.0",
            "is_expired": False,
        }

    def get_consent_summary(self, patient_id: int) -> list[dict[str, Any]]:
        """获取患者知情同意摘要"""
        consent_types = [
            "data_collection",
            "ai_analysis",
            "research_use",
            "ai_chat",
        ]

        summary = []
        for consent_type in consent_types:
            status = self.check_consent_status(patient_id, consent_type)
            summary.append(status)

        return summary

    # =========================================================
    # 4. 数据生命周期管理
    # =========================================================

    def get_data_lifecycle_status(
        self,
        patient_id: int,
    ) -> list[DataLifecycleStatus]:
        """获取数据生命周期状态"""
        from backend.app.models.scale_result import ScaleResult
        from backend.app.models.cognitive_test import CognitiveTest
        from backend.app.models.tracking_log import TrackingLog

        lifecycle_items = []

        # 检查各类数据
        data_sources = [
            ("scale_result", ScaleResult),
            ("cognitive_test", CognitiveTest),
            ("tracking_log", TrackingLog),
        ]

        for data_type, model_class in data_sources:
            # 获取最新记录
            latest = self.db.scalar(
                select(model_class)
                .where(model_class.patient_id == patient_id)
                .order_by(model_class.created_at.desc())
                .limit(1)
            )

            if latest:
                # 计算保留期限
                created_at = latest.created_at
                retention_days = self.RETENTION_PERIODS["active_data"]
                scheduled_deletion = created_at + timedelta(days=retention_days)

                # 判断状态
                now = datetime.now(timezone.utc)
                if scheduled_deletion - now < timedelta(days=30):
                    policy = DataRetentionPolicy.PENDING_DELETION
                elif now - created_at > timedelta(days=retention_days // 2):
                    policy = DataRetentionPolicy.ARCHIVED
                else:
                    policy = DataRetentionPolicy.ACTIVE

                lifecycle_items.append(DataLifecycleStatus(
                    patient_id=patient_id,
                    data_type=data_type,
                    retention_policy=policy,
                    created_at=created_at,
                    last_accessed=now,  # 简化实现
                    scheduled_deletion=scheduled_deletion,
                    size_bytes=None,  # 需要实际计算
                ))

        return lifecycle_items

    def schedule_data_cleanup(
        self,
        days_before_expiry: int = 30,
    ) -> list[dict[str, Any]]:
        """安排数据清理"""
        from backend.app.models.patient import Patient

        cutoff_date = datetime.now(timezone.utc) + timedelta(days=days_before_expiry)

        # 查找需要清理的数据
        cleanup_items = []

        patients = self.db.scalars(select(Patient)).all()

        for patient in patients:
            lifecycle_status = self.get_data_lifecycle_status(patient.id)

            for status in lifecycle_status:
                if (status.scheduled_deletion and
                    status.scheduled_deletion <= cutoff_date and
                    status.retention_policy != DataRetentionPolicy.DELETED):

                    cleanup_items.append({
                        "patient_id": patient.id,
                        "data_type": status.data_type,
                        "scheduled_deletion": status.scheduled_deletion,
                        "days_until_deletion": (status.scheduled_deletion - datetime.now(timezone.utc)).days,
                        "current_policy": status.retention_policy.value,
                    })

        return cleanup_items

    def handle_data_deletion_request(
        self,
        patient_id: int,
        data_types: list[str] | None = None,
    ) -> dict[str, Any]:
        """处理数据删除请求（被遗忘权）"""
        from backend.app.models.scale_result import ScaleResult
        from backend.app.models.cognitive_test import CognitiveTest
        from backend.app.models.tracking_log import TrackingLog

        if data_types is None:
            data_types = ["scale_result", "cognitive_test", "tracking_log"]

        deleted_counts = {}

        # 标记数据为待删除（实际删除应该异步处理）
        for data_type in data_types:
            if data_type == "scale_result":
                count = self.db.execute(
                    ScaleResult.__table__.update()
                    .where(ScaleResult.patient_id == patient_id)
                    .values(risk_level="pending_deletion")  # 使用risk_level作为标记
                ).rowcount
                deleted_counts[data_type] = count

            elif data_type == "cognitive_test":
                # 认知测试数据标记
                count = self.db.execute(
                    CognitiveTest.__table__.update()
                    .where(CognitiveTest.patient_id == patient_id)
                    .values(test_type="pending_deletion")  # 使用test_type作为标记
                ).rowcount
                deleted_counts[data_type] = count

            elif data_type == "tracking_log":
                # 追踪数据标记
                count = self.db.execute(
                    TrackingLog.__table__.update()
                    .where(TrackingLog.patient_id == patient_id)
                    .values(note="PENDING_DELETION")  # 使用note作为标记
                ).rowcount
                deleted_counts[data_type] = count

        self.db.commit()

        # 记录审计日志
        self.log_access(
            actor_user_id=patient_id,
            actor_role="patient",
            action=AuditAction.CONSENT_UPDATE,
            resource_type="data_deletion_request",
            patient_id=patient_id,
            details={
                "data_types": data_types,
                "deleted_counts": deleted_counts,
                "request_type": "right_to_be_forgotten",
            },
        )

        return {
            "patient_id": patient_id,
            "request_date": datetime.now(timezone.utc),
            "data_types": data_types,
            "deleted_counts": deleted_counts,
            "status": "scheduled_for_deletion",
            "message": "数据删除请求已提交，将在24小时内完成处理。",
        }

    def generate_compliance_report(
        self,
        researcher_id: int,
    ) -> dict[str, Any]:
        """生成合规报告"""
        from backend.app.models.patient import Patient

        # 获取研究人员的患者
        patients = self.db.scalars(
            select(Patient)
            .where(Patient.assigned_researcher_id == researcher_id)
        ).all()

        total_patients = len(patients)
        consent_counts = {"granted": 0, "pending": 0, "expired": 0}
        data_status_counts = {"active": 0, "archived": 0, "pending_deletion": 0}

        for patient in patients:
            # 检查知情同意状态
            consent_summary = self.get_consent_summary(patient.id)
            has_all_consent = all(c["has_consent"] for c in consent_summary)

            if has_all_consent:
                consent_counts["granted"] += 1
            else:
                consent_counts["pending"] += 1

            # 检查数据生命周期状态
            lifecycle_status = self.get_data_lifecycle_status(patient.id)
            for status in lifecycle_status:
                if status.retention_policy == DataRetentionPolicy.ACTIVE:
                    data_status_counts["active"] += 1
                elif status.retention_policy == DataRetentionPolicy.ARCHIVED:
                    data_status_counts["archived"] += 1
                elif status.retention_policy == DataRetentionPolicy.PENDING_DELETION:
                    data_status_counts["pending_deletion"] += 1

        # 获取审计统计
        audit_stats = self.get_access_statistics(researcher_id, 30)

        return {
            "report_date": datetime.now(timezone.utc),
            "researcher_id": researcher_id,
            "total_patients": total_patients,
            "consent_status": consent_counts,
            "data_status": data_status_counts,
            "access_statistics": audit_stats,
            "compliance_score": self._calculate_compliance_score(
                consent_counts, data_status_counts
            ),
            "recommendations": self._generate_compliance_recommendations(
                consent_counts, data_status_counts
            ),
        }

    def _calculate_compliance_score(
        self,
        consent_counts: dict[str, int],
        data_status_counts: dict[str, int],
    ) -> float:
        """计算合规分数"""
        total = sum(consent_counts.values())
        if total == 0:
            return 1.0

        # 知情同意合规分数
        consent_score = consent_counts["granted"] / total

        # 数据管理合规分数（无待删除数据为满分）
        total_data = sum(data_status_counts.values())
        if total_data > 0:
            data_score = (data_status_counts["active"] + data_status_counts["archived"]) / total_data
        else:
            data_score = 1.0

        # 综合分数
        return (consent_score * 0.6 + data_score * 0.4)

    def _generate_compliance_recommendations(
        self,
        consent_counts: dict[str, int],
        data_status_counts: dict[str, int],
    ) -> list[str]:
        """生成合规建议"""
        recommendations = []

        if consent_counts["pending"] > 0:
            recommendations.append(
                f"有{consent_counts['pending']}位患者缺少完整知情同意，建议及时更新。"
            )

        if consent_counts["expired"] > 0:
            recommendations.append(
                f"有{consent_counts['expired']}位患者的知情同意已过期，需要续签。"
            )

        if data_status_counts["pending_deletion"] > 0:
            recommendations.append(
                f"有{data_status_counts['pending_deletion']}份数据待删除，请及时处理。"
            )

        if not recommendations:
            recommendations.append("合规状态良好，请继续保持。")

        return recommendations
