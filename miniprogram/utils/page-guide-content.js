const ONBOARDING_VERSION = 3

const DISCLAIMER = '本工具用于辅助筛查与随访，不替代医生诊断或用药建议。'

const ONBOARDING_CONTENT = Object.freeze({
  patient: Object.freeze({
    title: '欢迎使用 ADHD 智慧辅助平台',
    items: Object.freeze([
      '完成量表与认知任务',
      '记录每日状态变化',
      '查看医生消息和任务',
      '查看综合辅助报告',
      '由 AI 助手介绍页面、解释结果和提示下一步'
    ]),
    disclaimer: DISCLAIMER
  }),
  researcher: Object.freeze({
    title: '欢迎使用医生移动工作台',
    items: Object.freeze([
      '查看和绑定患者',
      '查看量表、认知和追踪摘要',
      '给患者下发任务并发送消息',
      '在手机端查看专业结果摘要',
      '影像上传、模型推理和 DAC 安全管理继续在电脑网页操作'
    ]),
    disclaimer: DISCLAIMER
  })
})

const PAGE_GUIDES = Object.freeze({
  home: ['我会根据你的完成情况，帮你找到今天最适合进行的下一步。', '介绍首页任务、进度和快捷入口。'],
  scale: ['没有一次答完也没关系，退出前我会帮你保存当前进度。', '说明量表填写、保存和提交方法。'],
  'cognitive-center': ['七项任务不用一次做完，可以分成几个短组合慢慢完成。', '介绍三个认知组合和完成顺序。'],
  cognitive: ['看到可点击目标就回应，遇到停止目标时请保持不动。', '说明反应抑制任务规则。'],
  'simple-reaction': ['等目标真正出现后再点击，提前点击也会被记录。', '说明简单反应时测试规则。'],
  stroop: ['请判断文字显示的颜色，不要被文字本身的含义干扰。', '说明颜色干扰任务规则。'],
  trail: ['按正确顺序寻找目标，点错后继续找当前正确节点。', '说明连线测试规则。'],
  flanker: ['只判断中间箭头方向，不需要理会两侧箭头。', '说明箭头抗干扰任务规则。'],
  nback: ['请比较当前位置和两次之前，只有相同时才选择匹配。', '说明两步位置记忆任务规则。'],
  'digit-span': ['先记住数字，数字消失后再按要求顺背或倒背。', '说明数字广度测试规则。'],
  tracking: ['每天花一分钟记录，连续变化比某一天更有参考价值。', '说明快速记录与详细记录。'],
  'tracking-trend': ['这里展示近期变化，请关注趋势，不必纠结单日高低。', '说明如何理解追踪趋势。'],
  report: ['报告汇总多类结果，但不能单独作为临床诊断。', '介绍综合报告各部分。'],
  'patient-tasks': ['这里显示医生安排的任务、截止时间和完成状态。', '说明医生任务和系统建议的区别。'],
  'patient-messages': ['可以在这里查看医生消息并回复，紧急情况请直接就医。', '说明医患消息与发送失败重试。'],
  'care-pathway': ['这里根据当前完成情况提示下一步，不等同于医生处方。', '说明系统关怀路径。'],
  'ai-chat': ['我可以解释和整理信息，但不能决定诊断或用药。', '说明 AI 助手能力边界。'],
  education: ['这里提供经过筛选的科普内容，帮助你了解相关知识。', '介绍科普内容查找和阅读方法。'],
  'privacy-settings': ['你可以查看或清除保存在本机上的草稿与聊天记录。', '说明本地数据和引导设置。'],
  'doctor-home': ['这里汇总患者进度，方便优先处理需要关注的患者。', '介绍医生移动工作台。'],
  'doctor-patient': ['可以查看患者摘要、下发任务并发送随访消息。', '介绍患者详情和随访操作。'],
  'doctor-guide-settings': ['你可以管理页面介绍，并随时重新查看医生端功能总览。', '说明医生端引导设置和账号隐私边界。']
})

function getOnboardingContent(role) {
  const key = role === 'researcher' ? 'researcher' : 'patient'
  return { ...ONBOARDING_CONTENT[key], items: [...ONBOARDING_CONTENT[key].items] }
}

function getPageGuide(pageKey) {
  const key = Object.prototype.hasOwnProperty.call(PAGE_GUIDES, pageKey)
    ? pageKey
    : 'home'
  const [intro, helpPrompt] = PAGE_GUIDES[key]
  return { pageKey: key, version: 1, intro, helpPrompt }
}

module.exports = {
  ONBOARDING_VERSION,
  DISCLAIMER,
  getOnboardingContent,
  getPageGuide
}
