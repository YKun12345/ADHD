const { createScaleSession } = require('./scale-session')

const SNAP_DRAFT_KEY = 'scale_draft_snap_iv'

const SNAP_CONFIG = {
  title: 'SNAP-IV 儿童行为量表',
  scaleType: 'SNAP_IV',
  respondentType: 'parent',
  maxScore: 3,
  estimatedMinutes: 6,
  instructions: '请由熟悉孩子日常表现的家长，根据近 6 个月情况作答',
  options: [
    { label: '从不', value: 0 },
    { label: '偶尔', value: 1 },
    { label: '经常', value: 2 },
    { label: '非常频繁', value: 3 }
  ],
  questions: [
    '孩子做作业或完成任务时是否经常不注意细节、容易出错？',
    '孩子在课堂、游戏或活动中是否常常难以持续保持注意力？',
    '别人直接和孩子说话时，孩子是否经常像没在听一样？',
    '孩子是否常常无法按照指令把事情做完整？',
    '孩子是否经常难以整理学习用品、任务顺序或生活安排？',
    '孩子是否经常回避需要持续动脑的学习任务？',
    '孩子是否常把文具、作业本或生活用品弄丢？',
    '孩子是否容易被周围无关刺激吸引而分心？',
    '孩子是否经常忘记本来该做的事情？',
    '孩子是否经常手脚不停，坐着时也扭来扭去？',
    '在需要坐好的场合，孩子是否常常离开座位？',
    '孩子是否常常在不合适的场合跑来跑去或爬上爬下？',
    '孩子是否很难安静地参加游戏或休闲活动？',
    '孩子是否经常像停不下来一样，总在活动？',
    '孩子是否说话特别多，难以停下来？',
    '别人问题还没说完时，孩子是否经常抢着回答？',
    '孩子是否很难等待轮到自己？',
    '孩子是否经常打断别人或插入他人的活动？',
    '孩子被提醒时是否经常发脾气或顶嘴？',
    '孩子是否经常与成人争辩？',
    '孩子是否常常故意不配合规则或要求？',
    '孩子是否故意做让别人烦恼的事？',
    '孩子是否常常把自己的错误归咎于别人？',
    '孩子是否容易因为小事就被激怒？',
    '孩子是否经常处于生气、怨恨的状态？',
    '孩子是否表现出明显记仇或报复倾向？'
  ]
}

const {
  normalizeDraftAnswers,
  setAnswer,
  getQuestionState,
  buildScalePayload
} = createScaleSession(SNAP_CONFIG)

module.exports = {
  SNAP_DRAFT_KEY,
  SNAP_CONFIG,
  normalizeDraftAnswers,
  setAnswer,
  getQuestionState,
  buildScalePayload
}
