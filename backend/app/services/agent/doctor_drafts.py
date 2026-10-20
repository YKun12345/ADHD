"""Local, traceable editing suggestions; never clinical decisions or prescriptions."""
import re
from fastapi import HTTPException
from backend.app.services.agent.validators import source_refs

REASONS = {
    'execution_interrupted': '本次操作出现中断；请说明发生在哪一步、是否恢复，以及当时的操作环境',
    'high_omissions': '本次漏答较多；请说明是否来不及作答、没有看清提示或遇到操作困难',
    'too_few_trials': '本次有效试次不足；请说明是否完成全部步骤或提前结束',
    'too_fast_responses': '本次部分反应过快；请核对是否误触、提前按键或尚未理解规则',
    'incomplete': '本次记录不完整；请说明实际完成到哪一步',
    'practice_not_completed': '本次练习尚未完成；请核对是否理解练习要求',
}


def scoped_frame(frame, assessment_id):
    """A doctor draft uses their own selected, currently authorized evidence only."""
    actor, pid = frame['actor_user_id'], frame['patient_id']
    sessions = [row for row in frame['assessments'] if row.get('patient_id') == pid
                and row.get('responsible_doctor_id') == actor
                and assessment_id in (None, row['id'])]
    if not sessions:
        raise HTTPException(403, 'The actual responsible doctor evidence is no longer available.')
    ids = {row['id'] for row in sessions}
    plans = [row for row in frame['plans'] if row.get('patient_id') == pid
             and row.get('responsible_doctor_id') == actor and row['assessment_id'] in ids]
    versions = {row.get('current_plan_version_id') for row in plans}
    cycles = [row for row in frame['cycles'] if row.get('patient_id') == pid
              and row.get('responsible_doctor_id') == actor and row.get('plan_version_id') in versions]
    return {**frame, 'assessments': sessions, 'plans': plans, 'cycles': cycles}


def _short(value, size=100):
    return str(value or '').strip()[:size]


def _material_text(value):
    # Only quote operational/material descriptions. Medical instructions remain
    # in their original published opinion; do not turn them into a new plan.
    pieces = re.split(r'(?<=[。！？；\n])', str(value or ''))
    unsafe = re.compile(r'药|剂量|处方|服用|诊断|治疗|疗效|\d\s*(?:mg|ml|毫克|毫升)', re.I)
    return ''.join(part for part in pieces if not unsafe.search(part))[:350].strip()


def prepare(frame, kind):
    sessions, plans, cycles = frame['assessments'], frame['plans'], frame['cycles']
    missing, questions, quality_notes = [], [], []
    for session in sessions:
        items = {row['id']: row for row in session['items']}
        submitted = {row['assessment_item_id'] for row in session['submissions']}
        for item in session['items']:
            if item['id'] not in submitted:
                title = _short(item.get('title')) or f"项目 {item['id']}"
                missing.append({'assessment_id': session['id'], 'assessment_item_id': item['id'], 'title': title,
                    'suggested_question': f'当前获准材料中未见“{title}”的实际提交，请核对是否尚未完成、已提交但待确认，或不便提供。',
                    'source_refs': [session['source_ref']]})
        for item in session['submissions']:
            if item['quality_status'] not in {'limited', 'invalid'}:
                continue
            title = _short(items.get(item['assessment_item_id'], {}).get('title')) or '该项目'
            reasons = list(dict.fromkeys(str(row) for row in item.get('quality_reasons', [])))
            reasons_text = '；'.join(REASONS.get(reason, f'质量标记“{_short(reason, 70)}”的具体含义待核对') for reason in reasons[:4])
            question = f'关于“{title}”：{reasons_text or "质量原因尚未说明，具体情况待核对"}。不知道或不便提供可以明确说明。'
            questions.append({'assessment_id': session['id'], 'source_type': 'submission', 'source_key': item['submission_id'],
                'question': question[:2000], 'actual_quality_reasons': reasons, 'source_refs': [item['source_ref']]})
            quality_notes.append(question)
    coverage = []
    for cycle in cycles:
        summary = cycle.get('summary') or {}
        due, done = summary.get('due_count'), summary.get('completed_count')
        missing_dates = list(summary.get('missing_dates') or [])
        as_of = summary.get('as_of_date') or frame.get('as_of_date')
        future_dates = sorted({task['record_date'] for plan in plans for task in plan['tasks']
            if task.get('cycle_id') == cycle['id'] and as_of and task.get('record_date', '') > as_of})
        text = f"周期 {cycle['id']}：截至 {as_of or '日期待核对'}，实际记录 {done if type(done) is int else '待核对'} / {due if type(due) is int else '待核对'} 天"
        if missing_dates:
            text += '；未记录日期 ' + '、'.join(missing_dates[:8])
        text += '。未来日期尚未到期，缺失保持未记录；记录覆盖不能判断治疗效果。'
        coverage.append({'cycle_id': cycle['id'], 'missing_dates': missing_dates, 'future_dates': future_dates,
            'text': text, 'source_refs': [ref for ref in source_refs(frame) if ref.startswith(f"cycle:{cycle['id']}:")]})
    # The current responsible doctor may use an authorized predecessor opinion
    # after a real handoff. Authorship itself does not grant responsibility.
    reports = [(session, report) for session in sessions for report in session['reports']]
    latest_pair = max(reports, key=lambda pair: (pair[1].get('published_at') or '', pair[1]['version'], pair[1]['id']), default=None)
    latest_report = latest_pair[1] if latest_pair else None
    relevant_plans = [row for row in plans if not latest_pair or row['assessment_id'] == latest_pair[0]['id']]
    current_plan = max(relevant_plans, key=lambda row: row.get('revision', 0), default=None)
    version = next((row for row in (current_plan or {}).get('versions', []) if row['id'] == current_plan.get('current_plan_version_id')), None)
    report_material = _material_text(latest_report.get('body')) if latest_report else ''
    report_limits = _material_text(latest_report.get('limitations')) if latest_report else ''
    gap_lines = [row['suggested_question'] for row in missing[:4]]
    edits = quality_notes[:2] + gap_lines + [row['text'] for row in coverage[:2]]
    if report_material:
        edits.insert(0, '已发布材料说明：' + report_material)
    if report_limits:
        edits.append('已发布材料局限：' + report_limits)
    if current_plan:
        edits.append(f"现有计划处理状态：{current_plan.get('status', '待核对')}；收到、实际执行和新的阶段决定分别确认。")
    if not edits:
        edits.append('当前获准材料没有具体缺项或质量原因可供整理，请先核对实际原件和使用者的具体困难。')
    references = source_refs(frame)
    common = {'draft_method': 'local_structured_rules', 'missing_materials': missing[:12],
        'missing_materials_total': len(missing), 'coverage_notes': coverage, 'edit_suggestions': edits}
    if kind == 'draft_review_questions':
        return {**common, 'questions': questions}
    if kind == 'draft_plan':
        if not latest_report:
            raise HTTPException(409, 'Publish and read an actual doctor opinion before preparing its plan draft.')
        title = _short(version.get('title'), 120) if version else '待医生核对的日记录安排'
        instructions = (f'以当前“{title}”为编辑起点。\n' if version else '具体执行安排待医生确认。\n') + '\n'.join(edits)
        instructions += '\n请核对后填写具体日期和执行方式；本建议尚未改变原安排，也未发布。'
        plan = {'title': title, 'instructions': instructions[:4000], 'source_report_id': latest_report['id'],
            'source_plan_version_id': version['id'] if version else None, 'dates_status': 'requires_doctor_confirmation',
            'reason': '根据本轮实际材料准备编辑建议，专业意见、日期和发布仍由负责医生确认。',
            'source_refs': references, 'edit_suggestions': edits}
        return {**common, 'plan_draft': plan}
    text = '我已查看当前共享的材料，想和你核对以下情况：\n' + '\n'.join(edits)
    text += '\n不知道或不便提供可以说明；未记录不等于没有发生。我们会在核对后再确认后续安排。'
    return {**common, 'reply_draft': {'text': text[:2000], 'recipient_confirmed': False, 'source_refs': references}}
