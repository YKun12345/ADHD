// Display labels are separate from immutable protocol names and fingerprints.
const TASK_TITLES = Object.freeze({
  reaction: '反应抑制测试', stroop: '颜色干扰测试', flanker: '箭头抗干扰测试',
  nback: '工作记忆测试', trail: '连线切换测试', digit: '数字广度测试',
  ASRS: '成人注意力自评量表', SNAP_IV: '儿童注意力与行为量表'
})
function itemTitle(item = {}) {
  return TASK_TITLES[item.instrument] || TASK_TITLES[item.key] ||
    String(item.title || '评估项目').replace(/（工程演示）|\(工程演示\)/g, '')
}
function templateTitle(item = {}) {
  return ['adult','child'].includes(item.age_group)
    ? `${item.age_group === 'adult' ? '成人' : '儿童'}注意力评估`
    : String(item.title || '注意力评估').replace(/工程演示/g, '')
}
module.exports = { itemTitle, templateTitle }
