const { request } = require('./request')

const METRIC_LABELS = {
  total_score: '原始总分', focus_minutes: '专注分钟', attention_rating: '注意力自评分',
  hyperactivity_rating: '多动自评分', impulsivity_rating: '冲动自评分', emotion_rating: '情绪自评分',
  task_completion_rating: '任务完成自评分', accuracy: '正确率', total_trials: '实际试次数',
  correct_trials: '正确试次数', average_reaction_time_ms: '平均反应时间（毫秒）',
  median_reaction_time_ms: '反应时间中位数（毫秒）', elapsed_ms: '用时（毫秒）',
  forward_max_span: '顺背最大长度', backward_max_span: '倒背最大长度'
}
const FIELD_LABELS = { note: '备注', side_effects: '自报不适', special_events: '特殊事件', highlights: '亮点',
  sleep_quality: '睡眠自报', appetite_quality: '食欲自报', has_conflict: '自报发生冲突', was_criticized: '自报受到批评' }
const finite = value => typeof value === 'number' && Number.isFinite(value)
const id = value => Number.isInteger(value) && value > 0

function buildFollowupDisplay(source, patientId) {
  if (!source || source.patient_id !== patientId || !Array.isArray(source.cycles) || !Array.isArray(source.measurements) ||
    !Array.isArray(source.comparisons) || !source.coverage || source.treatment_effect_conclusion_allowed !== false) {
    throw new Error('阶段总结来源不一致，请重新读取。')
  }
  if (source.cycles.some(row => !id(row.cycle_id) || !row.source_ref || row.source_ref.id !== row.cycle_id) ||
    source.measurements.some(row => row.patient_id !== patientId || !row.source_ref || row.source_ref.id !== row.submission_id)) {
    throw new Error('阶段总结缺少实际原始来源。')
  }
  return {
    asOfDate: source.as_of_date,
    coverageText: finite(source.coverage.ratio)
      ? `${source.coverage.completed_unique_dates} / ${source.coverage.due_unique_dates} 个到期日期（${Math.round(source.coverage.ratio * 100)}%）`
      : '尚无到期日期，覆盖率未知',
    cycles: source.cycles.map(row => ({ ...row,
      title: `${row.cycle_type === 'professional' ? '医生计划' : '自主记录'}：${row.start_date} 至 ${row.end_date}`,
      stateText: ({ active: '进行中', ended: '已结束', suspended: '已暂停' })[row.processing_status] || row.processing_status,
      coverageText: `${row.coverage.completed_count} / ${row.coverage.due_count} 个到期日期`,
      metricsText: Object.entries(row.metrics || {}).filter(([, value]) => finite(value.mean)).map(([key, value]) =>
        `${METRIC_LABELS[key] || key}：${value.mean}（实际记录${value.observed_days}天）`).join('；') || '尚无可计算的已记录指标',
      limitationsText: `补录${row.backfill_days}天；有修订${row.revised_days}天；自报事件${row.reported_event_days}天`
    })),
    measurements: source.measurements.map(row => ({ ...row,
      label: `${row.title || row.instrument} · ${String(row.committed_at || '').slice(0, 10)}`,
      valueText: Object.entries(row.metrics || {}).filter(([, value]) => finite(value)).map(([key, value]) =>
        `${METRIC_LABELS[key] || key}：${value}`).join('；') || '无已保存的数值指标',
      sourceText: `评估${row.assessment_id} / 执行${row.attempt_id} / ${row.submission_id}`
    })),
    comparisons: source.comparisons.map(row => ({ ...row,
      label: `${row.left.instrument}：${String(row.left.committed_at).slice(0, 10)} → ${String(row.right.committed_at).slice(0, 10)}`,
      reasonText: (row.reasons || []).map(reason => reason.message).join(' ')
    })),
    events: (source.reported_events || []).map(row => ({ ...row,
      text: Object.entries(row.fields || {}).map(([key, value]) => `${FIELD_LABELS[key] || key}：${value === true ? '是' : value}`).join('；')
    })),
    nextSteps: source.next_steps || [], limitations: source.limitations || [],
    truncatedText: Object.entries(source.truncated || {}).some(([key, value]) => !key.endsWith('_limit') && value === true)
      ? '当前展示最近一组资料，较早原始记录仍保留在各周期和评估中。' : ''
  }
}

async function fetchFollowupSummary(patientId) {
  if (!id(patientId)) throw new Error('请选择实际档案。')
  const result = await request({ url: `/care/followup-summary?patient_id=${patientId}` })
  return buildFollowupDisplay(result, patientId)
}

module.exports = { buildFollowupDisplay, fetchFollowupSummary }
