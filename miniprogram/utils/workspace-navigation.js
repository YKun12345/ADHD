const TABS = {
  patient: [['home','首页','home'],['assessments','评估','scale'],['records','记录','tracking'],['communication','沟通','ai'],['account','我的','account']],
  researcher: [['home','工作台','workbench'],['patients','用户','users'],['communication','沟通','ai'],['account','我的','account']]
}
const ENTRIES = {
  patient: {
    assessments: [['assessment','本轮评估与历史轮次','选择实际轮次，完成量表、测试或查看医生意见'],['self_report','我的数据与报告','查看自己的既有数据和综合报告'],['care_pathway','我的照护路径','查看评估与后续安排',true],['education','注意力科普','了解评估和日常注意力知识',true]],
    records: [['cycle','日期记录','按真实日期记录，查看修订和阶段安排'],['followup_summary','阶段与长期回顾','查看日期覆盖、困难及可比变化'],['legacy_records','旧版14天历史','查看旧版记录；新随访从日期记录进入',true]],
    communication: [['shared_messages','和医生沟通','选择已确认的共享关系，阅读或发送消息'],['tasks','医生交办事项','查看医生已下发的任务'],['attention','关注与处理状态','查看需要继续处理的事项',true],['queue','发送与恢复','核对本机待确认原件',true],['legacy_messages','历史医生消息','查看原有沟通记录',true],['agent','问问星仔','一起理清下一小步',true]],
    account: [['privacy','账号与隐私','管理本人、监护关系、共享及用途授权'],['notifications','消息提醒','查看微信提醒是否开通、许可及投递状态'],['queue','发送与恢复','核对本机待确认原件',true],['server','连接设置','查看或修改当前服务连接',true]]
  },
  researcher: {
    communication: [['shared_messages','共享消息','选择具体用户和有效共享关系'],['attention','审核与关注待办','查看需核对的材料与处理状态'],['queue','发送与恢复','核对本机待确认原件',true],['agent','问问星仔','整理当前获准材料或准备工作建议',true]],
    account: [['privacy','账号与隐私','管理工作设置、共享和用途授权'],['notifications','消息提醒','查看提醒许可和实际投递状态'],['queue','发送与恢复','核对本机待确认原件',true],['server','连接设置','查看或修改当前服务连接',true]]
  }
}
function itemsFor(role) { return (TABS[role] || []).map(([key,label,icon]) => ({ key,label,icon })) }
function sectionUrl(role, key) {
  if (!itemsFor(role).some(row => row.key === key)) return null
  if (key === 'home') return `/pages/${role === 'researcher' ? 'doctor-home' : 'home'}/index`
  if (key === 'patients') return '/pages/doctor-home/index?section=patients'
  return `/pages/workspace/index?section=${key}`
}
function entriesFor(role, section) { return (ENTRIES[role]?.[section] || []).map(([key,title,subtitle,secondary]) => ({ key,title,subtitle,secondary: Boolean(secondary) })) }
const NEED_PATIENT = new Set(['assessment','cycle','followup_summary','shared_messages','agent'])
function entryUrl(role, section, key, patientId) {
  if (!entriesFor(role,section).some(row => row.key === key)) return null
  if (NEED_PATIENT.has(key) && (!Number.isSafeInteger(patientId) || patientId <= 0)) return null
  const pages = { assessment:'assessments', self_report:'report', cycle:'care-cycles', followup_summary:'followup-summary', shared_messages:'shared-messages',
    tasks:'patient-tasks', legacy_messages:'patient-messages', attention:'care-attention', queue:'submission-queue', agent:'agent-chat', legacy_records:'tracking-trend',
    care_pathway:'care-pathway', education:'education', privacy:role === 'researcher' ? 'doctor-guide-settings' : 'privacy-settings', notifications:'notifications', server:'server-settings' }
  return `/pages/${pages[key]}/index${NEED_PATIENT.has(key) ? `?patient_id=${patientId}` : ''}`
}
module.exports = { itemsFor, sectionUrl, entriesFor, entryUrl }
