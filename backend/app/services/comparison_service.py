"""Programmed comparability from authenticated originals, never from AI text.

An identical protocol is one condition, not an equivalence certificate. The
currently admitted engineering templates have no clinical/device validation;
their results remain side-by-side observations even when every field matches.
"""
from calendar import monthrange
from datetime import datetime, timezone
import math

from fastapi import HTTPException
from sqlalchemy import select

from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.assessment import AssessmentItem, AssessmentSession, TaskAttempt
from backend.app.models.cognitive_test import CognitiveTest
from backend.app.models.scale_result import ScaleResult
from backend.app.models.submission import SubmissionRecord
from backend.app.schemas.comparison import ResultComparison
from backend.app.services.assessment_service import _require_visible
from backend.app.services.identity_access import require_processing_access
from backend.app.services.submission_service import _verify_record

RULE_VERSION = 'w10-comparison-1'
STATUS_LABELS = {'comparable': '可比', 'limited': '有局限', 'not_comparable': '不可比'}


def _utc(value):
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def measurement(db, user, row):
    """Check scope before decrypting a real, nonlegacy submission/result."""
    require_processing_access(db, user, row.patient_id, 'assessment')
    session = db.get(AssessmentSession, row.assessment_id)
    if session is None:
        raise RecordIntegrityError('The original assessment is missing.')
    _require_visible(session, user)
    _verify_record(db, row)
    attempt = db.get(TaskAttempt, row.attempt_id)
    item = db.get(AssessmentItem, row.assessment_item_id)
    if attempt is None or item is None or (attempt.patient_id, attempt.assessment_id, attempt.assessment_item_id) != (row.patient_id, row.assessment_id, row.assessment_item_id):
        raise RecordIntegrityError('The comparison requires the actual original attempt and item.')
    start = attempt.execution_metadata
    metadata = row.execution_metadata.get('completion') or start
    metrics = {}
    if row.kind == 'scale':
        result = db.get(ScaleResult, row.scale_result_id)
        if _number(result.total_score):
            metrics['total_score'] = result.total_score
    else:
        result = db.get(CognitiveTest, row.cognitive_result_id)
        # Only finite scalar values actually computed/stored by the server.
        # Raw trials, arrays, client summaries and free text are not projected.
        for key, value in ((result.result_json or {}).get('raw_result') or {}).items():
            if _number(value) and key not in {'schema_version', 'protocol_schema_version'}:
                metrics[key] = value
    return {
        'submission_id': row.submission_id, 'patient_id': row.patient_id,
        'assessment_id': row.assessment_id, 'assessment_item_id': row.assessment_item_id,
        'attempt_id': row.attempt_id, 'result_id': row.scale_result_id if row.kind == 'scale' else row.cognitive_result_id,
        'kind': row.kind, 'instrument': item.instrument, 'title': item.definition_snapshot.get('title', item.instrument),
        'protocol_id': row.protocol_id, 'protocol_schema_version': row.protocol_schema_version,
        'config_digest': row.config_digest, 'content_digest': item.definition_snapshot.get('content_digest'),
        'source': session.source, 'age_at_attempt': attempt.age_at_attempt, 'age_group': attempt.age_group,
        'performer_kind': row.performer_kind, 'performer_user_id': row.performer_user_id,
        'performer_patient_id': row.performer_patient_id, 'respondent_user_id': row.respondent_user_id,
        'respondent_kind': row.respondent_kind, 'recall_window': attempt.recall_window,
        'quality_status': row.quality_status, 'quality_reasons': list(row.quality_reasons),
        'acceptance_status': row.acceptance_status,
        'device': metadata.get('device'), 'input': metadata.get('input'), 'timing': metadata.get('timing'),
        'practice': metadata.get('practice'), 'assistance': metadata.get('assistance'),
        'interrupted_count': metadata.get('interrupted_count'),
        'prior_started_attempt_count': start.get('prior_started_attempt_count'),
        'retake_interval_seconds': start.get('retake_interval_seconds'),
        'started_at': _utc(attempt.created_at).isoformat(), 'committed_at': _utc(row.committed_at).isoformat(),
        'demonstration_only': session.demonstration_only,
        'professional_approval': session.template_snapshot.get('professional_approval'),
        'metrics': metrics,
        'source_ref': {'type': 'submission', 'id': row.submission_id, 'assessment_id': row.assessment_id,
                       'attempt_id': row.attempt_id, 'canonical_digest': row.canonical_digest},
    }


def compare_measurements(left, right):
    """Pure policy; inputs must be built by measurement(), not an HTTP body."""
    reasons = []

    def reason(code, text, severity='limited'):
        reasons.append({'code': code, 'message': text, 'severity': severity})

    if left['patient_id'] != right['patient_id']:
        raise HTTPException(422, 'Only two originals belonging to the same patient may be compared.')
    if left['submission_id'] == right['submission_id']:
        raise HTTPException(422, 'Choose two different actual submissions.')
    interval = abs((_utc(datetime.fromisoformat(right['started_at'])) - _utc(datetime.fromisoformat(left['started_at']))).total_seconds()) / 86400
    for key, label in [('kind', '测量类型'), ('instrument', '量表或任务'), ('protocol_id', '协议'),
                       ('protocol_schema_version', '协议版本'), ('config_digest', '配置'), ('age_group', '适用年龄组')]:
        if left.get(key) != right.get(key):
            reason(key + '_differs', label + '不同，不能直接比较数值变化。', 'not_comparable')
    if left.get('source') != right.get('source'):
        reason('source_differs', '两次资料来源不同，需结合各自用途阅读。')
    for key, label in [('performer_kind', '执行者类型'), ('performer_user_id', '实际执行者'),
                       ('performer_patient_id', '实际执行者档案'), ('respondent_kind', '填写者关系'),
                       ('respondent_user_id', '实际填写者')]:
        if left.get(key) != right.get(key):
            reason(key + '_differs', label + '不同，不能将评分差异解释为个人改善。', 'not_comparable')
    for value in (left, right):
        if value.get('quality_status') == 'invalid':
            reason('invalid_original', '至少一次原始资料未通过质量校验。', 'not_comparable')
        elif value.get('quality_status') != 'valid':
            reason('quality_limited', '至少一次原始资料质量受限或未知。')
    if any(value.get('demonstration_only') or not value.get('professional_approval') for value in (left, right)):
        reason('professional_equivalence_not_verified', '当前工程模板尚无已核验的专业等价与解释批准，仅并列展示原始结果。')
    if left['kind'] == 'scale' and right['kind'] == 'scale':
        if left.get('content_digest') != right.get('content_digest'):
            reason('wording_differs', '量表原始措辞版本不同。', 'not_comparable')
        if not left.get('recall_window') or not right.get('recall_window'):
            reason('recall_window_unknown', '原始回忆窗口未知。')
        elif left['recall_window'] != right['recall_window']:
            reason('recall_window_differs', '两次回忆窗口不同。', 'not_comparable')
        elif left['recall_window'] == 'P6M':
            earlier, later = sorted(datetime.fromisoformat(value['started_at']) for value in (left, right))
            month = earlier.month + 6
            year, month = earlier.year + (month - 1) // 12, (month - 1) % 12 + 1
            six_months = earlier.replace(year=year, month=month, day=min(earlier.day, monthrange(year, month)[1]))
            if later < six_months:
                reason('P6M_window_overlap', '两次量表均回顾近六个月，窗口重叠；14天等短期重测不能解释为这段时间的治疗效果。')
        reason('completeness_checked_at_commit', '完整性按原提交质量记录核验；未知或缺失未补成0。') if any(value.get('quality_status') != 'valid' for value in (left, right)) else None
    else:
        # No server-approved device equivalence registry exists in the admitted
        # templates. Even an identical self-reported device is not calibration.
        reason('device_equivalence_not_verified', '记录相同设备或协议不代表已校准；尚无服务端核验的设备等价条件。')
        for key, label in [('device', '设备、环境或刺激布局'), ('input', '输入方式'), ('timing', '计时条件'),
                           ('practice', '练习与重复暴露'), ('assistance', '协助条件')]:
            if not left.get(key) or not right.get(key):
                reason(key + '_unknown', label + '信息不完整。')
            elif left[key] != right[key]:
                reason(key + '_differs', label + '不同。', 'not_comparable' if key in {'device', 'input'} else 'limited')
        if any(not (value.get('timing') or {}).get('calibrated') for value in (left, right)):
            reason('timing_not_calibrated', '至少一次计时未校准。')
        if any(value.get('prior_started_attempt_count') is None for value in (left, right)):
            reason('repeat_exposure_unknown', '实际重复暴露次数不完整。')
        elif left['prior_started_attempt_count'] != right['prior_started_attempt_count']:
            reason('repeat_exposure_differs', '两次开始前的实际任务暴露次数不同，可能存在练习影响。')
        if interval < 14:
            reason('short_retest_interval', '重测间隔不足14天；间隔本身不构成可比或疗效证据。')
    status = 'not_comparable' if any(row['severity'] == 'not_comparable' for row in reasons) else 'limited' if reasons else 'comparable'
    changes = []
    if status == 'comparable':
        for key in left['metrics'].keys() & right['metrics'].keys():
            changes.append({'metric': key, 'left': left['metrics'][key], 'right': right['metrics'][key],
                            'difference': right['metrics'][key] - left['metrics'][key]})
    # Repeated codes are deduplicated without losing the original severity.
    reasons = list({(row['code'], row['severity']): row for row in reasons}.values())
    return ResultComparison(rule_version=RULE_VERSION, patient_id=left['patient_id'], status=status,
        status_label=STATUS_LABELS[status], left=left, right=right, interval_days=round(interval, 6),
        reasons=reasons, numeric_changes=changes, treatment_effect_conclusion_allowed=False,
        interpretation='仅描述有来源的观察与可比限制；不能据此归因治疗改善或恶化。').model_dump()


def compare_submissions(db, user, patient_id, left_submission_id, right_submission_id):
    require_processing_access(db, user, patient_id, 'assessment')
    rows = []
    for identifier in (left_submission_id, right_submission_id):
        row = db.scalar(select(SubmissionRecord).where(SubmissionRecord.submission_id == identifier, SubmissionRecord.patient_id == patient_id))
        if row is None:
            raise HTTPException(404, 'Original submission not found for this patient.')
        rows.append(measurement(db, user, row))
    from backend.app.services.care_cycle_service import _audit
    result = compare_measurements(*rows)
    _audit(db, user, patient_id, 'result_comparison_read', submission_ids=[left_submission_id, right_submission_id], rule_version=RULE_VERSION)
    return result
