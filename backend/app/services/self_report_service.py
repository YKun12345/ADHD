"""Actual rule-produced screening versions; never a fictional doctor review."""
from sqlalchemy import select
from backend.app.models.review import ReportVersion, metadata
from backend.app.models.assessment import AssessmentItem
from backend.app.models.submission import SubmissionRecord
from backend.app.models.scale_result import ScaleResult
from backend.app.models.cognitive_test import CognitiveTest
from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.services.submission_service import _verify_record, context_dict
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.review_service import _utc


RULE_VERSION = 'self-screening-records-1'


def publish_self_report(db, session, event, manifest, now):
    from backend.app.db.review_migration import require_review_schema
    require_review_schema(db.connection())
    if session.source != 'self' or session.responsible_doctor_id is not None or session.status != 'closed_self':
        raise RecordIntegrityError('A system screening report requires an actual closed self assessment.')
    client_id = f'self-screening:{session.id}:v1'
    previous = db.scalar(select(ReportVersion).where(ReportVersion.client_publication_id == client_id))
    if previous is not None:
        if previous.assessment_id != session.id or previous.category != 'self_screening' or previous.review_id is not None:
            raise RecordIntegrityError('The immutable system report belongs to different source material.')
        return previous
    items = db.scalars(select(AssessmentItem).where(AssessmentItem.assessment_id == session.id).order_by(AssessmentItem.id)).all()
    evidence = []
    for ref in manifest:
        row = db.scalar(select(SubmissionRecord).where(SubmissionRecord.submission_id == ref['submission_id'],
            SubmissionRecord.patient_id == session.patient_id, SubmissionRecord.assessment_id == session.id))
        if row is None or row.canonical_digest != ref['canonical_digest']:
            raise RecordIntegrityError('The screening source manifest differs from the actual original.')
        _verify_record(db, row)
        if row.kind == 'scale':
            result = db.get(ScaleResult, row.scale_result_id)
            result_value = {'kind': 'scale', 'id': result.id, 'scale_type': result.scale_type,
                'total_score': result.total_score, 'risk_level': result.risk_level, 'score_json': result.score_json}
        else:
            result = db.get(CognitiveTest, row.cognitive_result_id)
            result_value = {'kind': 'cognitive', 'id': result.id, 'test_type': result.test_type, 'result_json': result.result_json}
        evidence.append({**context_dict(row), 'canonical_digest': row.canonical_digest, 'quality_status': row.quality_status,
            'quality_reasons': row.quality_reasons, 'quality_rule_version': row.quality_rule_version,
            'acceptance_status': row.acceptance_status, 'comparability_status': row.comparability_status,
            'comparability_reasons': row.comparability_reasons, 'server_result': result_value, 'committed_at': _utc(row.committed_at)})
    missing = [item.key for item in items if item.id not in {row['assessment_item_id'] for row in evidence}]
    if missing:
        raise RecordIntegrityError('Self closure cannot fabricate missing applicable material.')
    inputs = {'assessment_id': session.id, 'patient_id': session.patient_id, 'assessment_version': session.version,
        'source': 'self', 'responsible_doctor_id': None, 'template_id': session.template_id,
        'template_version': session.template_version, 'template_digest': session.template_digest,
        'age_group': session.age_group, 'age_at_assessment': session.age_at_assessment,
        'background_visibility': 'not_included', 'evidence': evidence, 'missing_items': missing,
        'items': [{'assessment_item_id': item.id, 'key': item.key, 'instrument': item.instrument,
            'definition': item.definition_snapshot} for item in items], 'model_evidence_status': 'not_admitted', 'rules_version': RULE_VERSION}
    payload = {'source_event_id': event.event_id, 'assessment_id': session.id, 'patient_id': session.patient_id,
        'category': 'self_screening', 'rules_version': RULE_VERSION, 'input_digest': canonical_digest(inputs)}
    when = now.replace(microsecond=0)
    report = ReportVersion(patient_id=session.patient_id, assessment_id=session.id, review_id=None, actor_user_id=event.actor_user_id,
        client_publication_id=client_id, category='self_screening', version=1, expected_assessment_version=event.revision,
        input_digest=payload['input_digest'], payload_digest=canonical_digest(payload), published_at=when)
    ack = {'client_publication_id': client_id, 'patient_id': session.patient_id, 'assessment_id': session.id, 'review_id': None,
        'actor_user_id': event.actor_user_id, 'actor_identity_basis': event.actor_identity_basis,
        'publisher_kind': 'system', 'system_principal': 'self_screening_rules', 'professional_confirmation': False,
        'responsible_doctor_id': None, 'version': 1, 'category': 'self_screening', 'status': 'published', 'assessment_status': 'closed_self',
        'assessment_version': session.version, 'expected_assessment_version': event.revision, 'input_digest': report.input_digest,
        'body': f'本轮{len(items)}个适用项目均有实际质量有效原件。标准计分与原件来源已冻结，可逐项查看。自助筛查不能确定诊断；如有持续困扰，请联系合格专业人员进一步评估。',
        'limitations': '演示模板与合成运行仅用于流程验证。背景未纳入本报告，不推断未知病史；近六个月量表不能直接解释短周期治疗效果，不同协议或设备只并列原始结果。无获准模型概率或医生专业确认。',
        'decisions': [], 'authorization_snapshot': event.payload['authorization_snapshot'], 'published_at': _utc(when),
        'payload_digest': report.payload_digest, 'demonstration_only': session.demonstration_only, 'rules_version': RULE_VERSION}
    report.snapshot = {'metadata': metadata(report), 'payload': payload, 'ack': ack, 'input_snapshot': inputs,
        'authorization_snapshot': event.payload['authorization_snapshot']}
    db.add(report); db.flush()
    from backend.app.services.security_service import _append_audit_log
    _append_audit_log(db, action='self_screening_report_created', status='success', actor_user_id=None, patient_id=session.patient_id,
        message='系统按实际自助原件生成非诊断筛查版本。', detail_json={'system_principal': 'self_screening_rules',
            'actual_trigger_actor_user_id': event.actor_user_id, 'source_event_id': event.event_id,
            'assessment_id': session.id, 'report_id': report.id, 'input_digest': report.input_digest, 'rules_version': RULE_VERSION})
    return report
