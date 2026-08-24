const MAX_PROMPT_LENGTH = 4000

const COPILOT_PAGE_KEYS = Object.freeze([
  'home',
  'scale',
  'cognitive-center',
  'cognitive',
  'stroop',
  'tracking',
  'tracking-trend',
  'report',
  'care-pathway',
  'education',
  'education-detail'
])

const GENERAL_CONFIG = Object.freeze({
  pageKey: 'general',
  title: '当前页面',
  advice: '可以询问本页操作方法或健康相关问题。',
  helpPrompt: '请介绍当前页面应该怎样使用。'
})

const PAGE_CONFIGS = Object.freeze({
  home: {
    pageKey: 'home',
    title: '患者首页',
    advice: '按当天任务顺序完成量表、测试和追踪。',
    helpPrompt: '请介绍患者首页的任务、进度和快捷入口应该怎样使用。'
  },
  scale: {
    pageKey: 'scale',
    title: '量表页面',
    advice: '按近期真实情况逐题选择，提交前检查漏答。',
    helpPrompt: '请告诉我如何完成当前量表，以及漏答后应该怎么检查。'
  },
  'cognitive-center': {
    pageKey: 'cognitive-center',
    title: '认知测试中心',
    advice: '先阅读说明，再在安静环境中开始测试。',
    helpPrompt: '请介绍认知测试中心的入口、测试顺序和注意事项。'
  },
  cognitive: {
    pageKey: 'cognitive',
    title: 'Go/No-Go 测试',
    advice: '保持注意，按页面规则完成测试。',
    helpPrompt: '请用简单步骤说明 Go/No-Go 测试怎样操作。'
  },
  stroop: {
    pageKey: 'stroop',
    title: 'Stroop 测试',
    advice: '根据当前规则作答，尽量兼顾准确和稳定。',
    helpPrompt: '请用简单步骤说明 Stroop 测试怎样操作。'
  },
  tracking: {
    pageKey: 'tracking',
    title: '每日追踪',
    advice: '如实记录当天睡眠、情绪和用药情况。',
    helpPrompt: '请说明每日追踪每一项应该怎样填写。'
  },
  'tracking-trend': {
    pageKey: 'tracking-trend',
    title: '追踪趋势',
    advice: '结合多日变化看趋势，不根据单日数据下结论。',
    helpPrompt: '请告诉我怎样查看和理解追踪趋势页面。'
  },
  report: {
    pageKey: 'report',
    title: '综合报告',
    advice: '综合报告用于辅助了解情况，不替代医生诊断。',
    helpPrompt: '请介绍综合报告各部分的含义和查看方法。'
  },
  'care-pathway': {
    pageKey: 'care-pathway',
    title: '照护路径',
    advice: '按阶段查看建议，并在需要时联系专业人员。',
    helpPrompt: '请告诉我怎样使用照护路径页面安排下一步。'
  },
  education: {
    pageKey: 'education',
    title: '科普教育',
    advice: '优先阅读与当前任务相关的健康教育内容。',
    helpPrompt: '请介绍科普教育列表应该怎样查找和阅读内容。'
  },
  'education-detail': {
    pageKey: 'education-detail',
    title: '科普详情',
    advice: '阅读后可返回列表继续选择其他主题。',
    helpPrompt: '请介绍科普详情页内容应该怎样阅读和使用。'
  }
})

function getCopilotConfig(pageKey) {
  const config = PAGE_CONFIGS[pageKey] || GENERAL_CONFIG
  return { ...config }
}

function buildAiChatUrl(pageKey, mode = 'free') {
  const baseUrl = '/pages/ai-chat/index?scope=general'
  if (mode !== 'help') return baseUrl

  const prompt = getCopilotConfig(pageKey).helpPrompt.slice(
    0,
    MAX_PROMPT_LENGTH
  )
  return `${baseUrl}&prompt=${encodeURIComponent(prompt)}`
}

module.exports = {
  COPILOT_PAGE_KEYS,
  getCopilotConfig,
  buildAiChatUrl
}
