const MAX_PROMPT_LENGTH = 4000
const {
  encodeInitialPrompt
} = require('./ai-chat')
const { getPageGuide } = require('./page-guide-content')

const COPILOT_PAGE_KEYS = Object.freeze([
  'home',
  'scale',
  'cognitive-center',
  'cognitive',
  'stroop',
  'trail',
  'flanker',
  'nback',
  'digit-span',
  'tracking',
  'tracking-trend',
  'report',
  'care-pathway',
  'education',
  'education-detail',
  'patient-tasks',
  'patient-messages',
  'privacy-settings',
  'doctor-home',
  'doctor-patient',
  'doctor-guide-settings',
  'ai-chat', 'assessments', 'doctor-review', 'review-questions', 'care-reports', 'doctor-plan', 'patient-plan',
  'care-cycles', 'cycle-review', 'shared-messages', 'followup-summary', 'imaging-reports'
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
    title: '用户首页',
    advice: '按当天任务顺序完成量表、测试和追踪。',
    helpPrompt: '请陪我看看用户首页，现在应该先做哪一步？'
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
    title: '反应抑制任务',
    advice: '保持注意，按页面规则完成测试。',
    helpPrompt: '请用简单步骤说明反应抑制任务怎样操作。'
  },
  stroop: {
    pageKey: 'stroop',
    title: '颜色干扰任务',
    advice: '根据当前规则作答，尽量兼顾准确和稳定。',
    helpPrompt: '请用简单步骤说明颜色干扰任务怎样操作。'
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
  },
  'doctor-guide-settings': {
    pageKey: 'doctor-guide-settings',
    title: '账号与隐私',
    advice: '可以在这里管理医生端页面介绍并重新查看功能总览。',
    helpPrompt: '请说明医生端引导设置和账号隐私边界。'
  },
  assessments: { pageKey: 'assessments', title: '本轮评估', advice: '我们一次只做一个项目，背景资料可以跳过。', helpPrompt: '请一步一步带我开始这轮评估。' },
  'doctor-review': { pageKey: 'doctor-review', title: '医生审核', advice: '先看材料，再补问或发布意见。', helpPrompt: '这轮材料如何审核，哪些需要补问或重测？' },
  'review-questions': { pageKey: 'review-questions', title: '补问与答复', advice: '针对医生的问题按实际情况回复，不知道也可以说明。', helpPrompt: '医生的补问应该在哪里回答？不知道怎么办？' },
  'care-reports': { pageKey: 'care-reports', title: '已发布意见', advice: '看不懂意见可以问我，专业判断由医生解释。', helpPrompt: '怎样查看本轮医生已经发布的意见？' },
  'doctor-plan': { pageKey: 'doctor-plan', title: '医生计划', advice: '核对已发布意见，再确认具体日期与安排。', helpPrompt: '请带我看看如何制定并发布这一轮计划。' },
  'patient-plan': { pageKey: 'patient-plan', title: '医生的安排', advice: '先读安排，再告诉医生是否收到、哪里有困难。', helpPrompt: '请带我看看医生计划，接下来怎么执行？' },
  'care-cycles': { pageKey: 'care-cycles', title: '今天的记录', advice: '选择真实日期，只填写实际情况。', helpPrompt: '今天应该怎么记录？哪些内容可以留空？' },
  'cycle-review': { pageKey: 'cycle-review', title: '阶段回顾', advice: '一起看看这段时间，再确认下一步。', helpPrompt: '这个周期结束了，接下来该怎么办？' },
  'shared-messages': { pageKey: 'shared-messages', title: '医患沟通', advice: '先确认发送对象，再说说实际遇到的困难。', helpPrompt: '我想向医生反馈困难，在哪里发消息？' },
  'followup-summary': { pageKey: 'followup-summary', title: '随访回顾', advice: '缺失记录不算零，先看实际完成情况。', helpPrompt: '如何看懂这段时间的随访记录和缺失？' },
  'imaging-reports': { pageKey: 'imaging-reports', title: '已有影像报告', advice: '查看已有分析和医生审核版本，原始影像在医生网页。', helpPrompt: '请告诉我这份影像报告应该怎么看。' }
})

function getCopilotConfig(pageKey) {
  const config = PAGE_CONFIGS[pageKey] || GENERAL_CONFIG
  const guide = getPageGuide(pageKey)
  return {
    ...config,
    ...(guide.pageKey === pageKey
      ? { pageKey: guide.pageKey, intro: guide.intro, version: guide.version, helpPrompt: guide.helpPrompt }
      : { intro: config.advice, version: 1 })
  }
}

function buildAiChatUrl(pageKey, mode = 'free') {
  const baseUrl = '/pages/agent-chat/index?scope=general'
  if (mode !== 'help') return baseUrl

  const prompt = getCopilotConfig(pageKey).helpPrompt.slice(
    0,
    MAX_PROMPT_LENGTH
  )
  return `${baseUrl}&prompt=${encodeInitialPrompt(prompt)}`
}

module.exports = {
  COPILOT_PAGE_KEYS,
  getCopilotConfig,
  buildAiChatUrl
}
