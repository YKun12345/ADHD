"""Source-linked multi-cycle observations; no invented dates, zeros or effects."""
from datetime import datetime, timezone
from statistics import mean
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, or_, select

from backend.app.models.assessment import AssessmentSession
from backend.app.models.care_cycle import CareCycle
from backend.app.models.submission import SubmissionRecord
from backend.app.schemas.comparison import FollowupSummary
from backend.app.services import care_cycle_service as cycles
from backend.app.services.comparison_service import compare_measurements, measurement, _number
from backend.app.services.identity_access import require_processing_access, self_access

RULE_VERSION = 'w10-followup-summary-1'
MAX_CYCLES = 24
MAX_MEASUREMENTS = 60
MAX_EVENTS = 60
DAILY_METRICS = ('focus_minutes', 'attention_rating', 'hyperactivity_rating', 'impulsivity_rating',
                 'emotion_rating', 'task_completion_rating')
EVENT_FIELDS = ('note', 'side_effects', 'special_events', 'highlights', 'sleep_quality', 'appetite_quality')


def _allowed(db, user, patient_id, scope):
    try:
        require_processing_access(db, user, patient_id, scope)
        return True
    except HTTPException as exc:
        if exc.status_code != 403:
            raise
        return False


def followup_summary(db, user, patient_id):
    # Each section has its own scope. A doctor with assessment-only sharing
    # must not obtain daily notes through an apparently generic summary API.
    assessment_allowed = _allowed(db, user, patient_id, 'assessment')
    tracking_allowed = _allowed(db, user, patient_id, 'tracking')
    if not assessment_allowed and not tracking_allowed:
        raise HTTPException(403, 'Current scoped authority and basic-use consent are required for a new summary.')
    today = datetime.now(timezone.utc).astimezone(ZoneInfo(cycles.CALENDAR)).date().isoformat()
    cycle_items, measurements, reported_events, next_steps = [], [], [], []
    due_dates, completed_dates = set(), set()
    cycle_count = measurement_count = 0
    if tracking_allowed:
        query = select(CareCycle).where(CareCycle.patient_id == patient_id)
        if not self_access(db, user.id, patient_id):
            query = query.where(CareCycle.cycle_type == 'professional', CareCycle.responsible_doctor_id == user.id)
        cycle_count = db.scalar(select(func.count()).select_from(query.subquery()))
        rows = db.scalars(query.order_by(CareCycle.start_date.desc(), CareCycle.id.desc()).limit(MAX_CYCLES)).all()
        for row in reversed(rows):
            detail = cycles.get_cycle(db, user, row.id)
            records = detail['records']
            values = {}
            for key in DAILY_METRICS:
                actual = [(record['record_date'], record['content'].get(key)) for record in records
                          if _number(record['content'].get(key))]
                values[key] = {'mean': round(mean(value for _, value in actual), 3) if actual else None,
                               'observed_days': len(actual), 'values': [{'date': day, 'value': value} for day, value in actual]}
            observed = detail['summary']
            due_dates.update(observed['completed_dates']); due_dates.update(observed['missing_dates'])
            completed_dates.update(observed['completed_dates'])
            backfills = [record for record in records if record['is_backfill']]
            revised = [record for record in records if record['revision'] > 1]
            event_count = 0
            for record in records:
                present = {key: record['content'][key] for key in EVENT_FIELDS if record['content'].get(key) not in (None, '')}
                if record['content'].get('has_conflict') is True:
                    present['has_conflict'] = True
                if record['content'].get('was_criticized') is True:
                    present['was_criticized'] = True
                if present:
                    event_count += 1
                    reported_events.append({'cycle_id': row.id, 'record_id': record['record_id'],
                        'record_date': record['record_date'], 'revision': record['revision'],
                        'reported_at': record['recorded_at'], 'fields': present,
                        'source_ref': {'type': 'daily_record', 'id': record['record_id'], 'cycle_id': row.id,
                                       'revision': record['revision'], 'content_digest': record['content_digest']}})
            availability = detail['processing_status']
            cycle_items.append({'cycle_id': row.id, 'cycle_type': row.cycle_type, 'start_date': detail['start_date'],
                'end_date': detail['end_date'], 'plan_version_id': row.plan_version_id,
                'responsible_doctor_id': row.responsible_doctor_id,
                'processing_status': availability, 'suspension_reason': detail['suspension_reason'],
                'coverage': observed, 'metrics': values, 'backfill_days': len(backfills), 'revised_days': len(revised),
                'reported_event_days': event_count,
                'source_ref': {'type': 'care_cycle', 'id': row.id, 'plan_version_id': row.plan_version_id}})
            if availability == 'suspended':
                next_steps.append({'kind': 'resolve_authority', 'cycle_id': row.id,
                    'label': '周期已暂停，请先处理授权或责任问题。',
                    'target': {'page': 'care-cycles', 'patient_id': patient_id, 'cycle_id': row.id}})
            elif row.end_date.isoformat() < today and availability != 'ended':
                next_steps.append({'kind': 'cycle_review', 'cycle_id': row.id,
                    'label': '本周期已到期，请进行阶段复核。' if row.cycle_type == 'professional' else '查看本周期总结并决定下一步。',
                    'target': {'page': 'cycle-review', 'patient_id': patient_id, 'cycle_id': row.id}})
            elif observed['missing_dates']:
                next_steps.append({'kind': 'record_observation', 'cycle_id': row.id,
                    'label': '有日期尚未记录；可按真实情况补录，原记录时间未知时保持未知。',
                    'target': {'page': 'care-cycles', 'patient_id': patient_id, 'cycle_id': row.id}})
    if assessment_allowed:
        query = select(SubmissionRecord).join(AssessmentSession, AssessmentSession.id == SubmissionRecord.assessment_id).where(
            SubmissionRecord.patient_id == patient_id,
            or_(AssessmentSession.source != 'doctor_assigned', AssessmentSession.published_at.is_not(None),
                AssessmentSession.responsible_doctor_id == user.id))
        measurement_count = db.scalar(select(func.count()).select_from(query.subquery()))
        originals = db.scalars(query.order_by(SubmissionRecord.committed_at.desc(), SubmissionRecord.id.desc()).limit(MAX_MEASUREMENTS)).all()
        measurements = [measurement(db, user, row) for row in reversed(originals)]
    # Adjacent originals of the same instrument, never a selected highest score.
    previous, comparisons = {}, []
    for value in measurements:
        key = (value['kind'], value['instrument'])
        if key in previous:
            comparisons.append(compare_measurements(previous[key], value))
        previous[key] = value
    events_total = len(reported_events)
    reported_events = sorted(reported_events, key=lambda row: (row['record_date'], row['record_id']), reverse=True)[:MAX_EVENTS]
    plan_ids = [row['plan_version_id'] for row in cycle_items if row['plan_version_id'] is not None]
    limitations = [
        '缺失日期、未填写指标和未知原记录时间保持未知，不按0计算。',
        '日记录为本人或监护人自报；覆盖率和均值不代表治疗效果。',
        '不同周期可能有计划版本、填写者、补录和外部事件变化，均需结合原始来源核对。',
        '六个月回忆量表的短期重测有窗口重叠；认知任务同协议不自动可比。',
        '旧day_index记录没有可靠日期，不并入真实日期周期。',
    ]
    if not assessment_allowed:
        limitations.append('当前未获得assessment范围，新摘要不读取量表或任务资料。')
    if not tracking_allowed:
        limitations.append('当前未获得tracking范围，新摘要不读取日记录或周期。')
    if len(set(plan_ids)) > 1:
        limitations.append('所列周期包含多个实际计划版本，不能将阶段差异单独归因某项干预。')
    result = FollowupSummary(rule_version=RULE_VERSION, patient_id=patient_id, as_of_date=today,
        calendar_timezone=cycles.CALENDAR, cycles=cycle_items, measurements=measurements, comparisons=comparisons,
        coverage={'due_unique_dates': len(due_dates), 'completed_unique_dates': len(completed_dates),
                  'missing_dates': sorted(due_dates - completed_dates),
                  'ratio': len(completed_dates) / len(due_dates) if due_dates else None,
                  'scope': 'listed_cycles', 'overlapping_cycle_dates_counted_once': True},
        reported_events=reported_events, next_steps=next_steps,
        limitations=limitations, truncated={'cycles': cycle_count > MAX_CYCLES,
            'measurements': measurement_count > MAX_MEASUREMENTS, 'reported_events': events_total > MAX_EVENTS,
            'cycle_limit': MAX_CYCLES, 'measurement_limit': MAX_MEASUREMENTS, 'event_limit': MAX_EVENTS})
    cycles._audit(db, user, patient_id, 'followup_summary_read', rule_version=RULE_VERSION,
        cycle_ids=[row['cycle_id'] for row in cycle_items], submission_ids=[row['submission_id'] for row in measurements])
    return result.model_dump()
