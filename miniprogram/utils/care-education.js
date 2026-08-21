const PATHWAY_STEP_IDS = Object.freeze([
  'account',
  'scale',
  'cognitive',
  'tracking',
  'report'
])

const EDUCATION_CATEGORIES = Object.freeze([
  { id: 'all', label: '全部' },
  { id: 'basics', label: '基础认识' },
  { id: 'assessment', label: '评估就诊' },
  { id: 'support', label: '日常支持' }
])

const DEFAULT_DISCLAIMER = '本文仅用于健康教育和辅助筛查，不替代专业医生诊断或处方建议。'

const SOURCES = Object.freeze({
  cdcOverview: {
    title: 'Attention-Deficit / Hyperactivity Disorder (ADHD)',
    organization: '美国疾病控制与预防中心（CDC）',
    url: 'https://www.cdc.gov/adhd/index.html'
  },
  cdcSymptoms: {
    title: 'Symptoms of ADHD',
    organization: '美国疾病控制与预防中心（CDC）',
    url: 'https://www.cdc.gov/adhd/signs-symptoms/index.html'
  },
  cdcTreatment: {
    title: 'Treatment of ADHD',
    organization: '美国疾病控制与预防中心（CDC）',
    url: 'https://www.cdc.gov/adhd/treatment/index.html'
  },
  cdcParent: {
    title: 'Parent Training in Behavior Management',
    organization: '美国疾病控制与预防中心（CDC）',
    url: 'https://www.cdc.gov/adhd/treatment/behavior-therapy.html'
  },
  cdcSchool: {
    title: 'ADHD in the Classroom',
    organization: '美国疾病控制与预防中心（CDC）',
    url: 'https://www.cdc.gov/adhd/treatment/classroom.html'
  },
  nimhOverview: {
    title: 'Attention-Deficit/Hyperactivity Disorder',
    organization: '美国国家精神卫生研究所（NIMH）',
    url: 'https://www.nimh.nih.gov/health/topics/attention-deficit-hyperactivity-disorder-adhd'
  },
  nimhAdult: {
    title: 'ADHD in Adults: 4 Things to Know',
    organization: '美国国家精神卫生研究所（NIMH）',
    url: 'https://www.nimh.nih.gov/health/publications/adhd-what-you-need-to-know'
  },
  niceOverview: {
    title: 'ADHD: diagnosis and management (NG87)',
    organization: '英国国家卫生与临床优化研究所（NICE）',
    url: 'https://www.nice.org.uk/guidance/ng87/'
  },
  niceRecommendations: {
    title: 'NG87 Recommendations',
    organization: '英国国家卫生与临床优化研究所（NICE）',
    url: 'https://www.nice.org.uk/guidance/ng87/chapter/recommendations'
  }
})

const EDUCATION_ARTICLES = Object.freeze([
  {
    id: 'understand-adhd',
    categoryId: 'basics',
    audiences: ['adult', 'child'],
    title: '认识 ADHD：不只是“注意力不好”',
    summary: '了解注意不集中、多动和冲动表现，以及为什么不同年龄的表现可能不同。',
    readMinutes: 4,
    updatedAt: '2026-08-21',
    sections: [
      {
        heading: '核心表现',
        paragraphs: [
          'ADHD 是一种神经发育障碍，核心表现涉及注意调节、多动和冲动控制。一个人可能以注意困难为主、多动冲动为主，也可能同时存在两类表现。',
          '儿童和成人的外在表现可能不同。成人的多动有时更多表现为内在不安、难以放松或任务组织困难。'
        ],
        points: []
      },
      {
        heading: '何时需要进一步了解',
        paragraphs: [
          '偶尔走神或拖延并不等于 ADHD。专业评估会关注表现是否持续、是否出现在多个重要场景，以及是否明显影响学习、工作、家庭或社交。'
        ],
        points: [
          '记录表现出现的时间、场景和影响。',
          '儿童可结合家庭与学校观察。',
          '成人可回顾童年表现及当前工作生活影响。'
        ]
      }
    ],
    sources: [SOURCES.cdcSymptoms, SOURCES.nimhOverview],
    disclaimer: DEFAULT_DISCLAIMER
  },
  {
    id: 'professional-assessment',
    categoryId: 'assessment',
    audiences: ['adult', 'child'],
    title: '为什么量表不能单独确诊',
    summary: '理解量表、访谈、多场景信息和共存情况在专业评估中的不同作用。',
    readMinutes: 5,
    updatedAt: '2026-08-21',
    sections: [
      {
        heading: '评估不是一次单项测试',
        paragraphs: [
          '没有一项量表、认知任务或影像检查能够单独完成 ADHD 诊断。量表适合帮助整理表现和影响，但结果需要放在完整临床与心理社会评估中理解。'
        ],
        points: [
          '专业人员会了解发展与健康史。',
          '会关注家庭、学校、工作等多个场景。',
          '会考虑睡眠、焦虑、抑郁、学习困难等可能相似或共存的情况。'
        ]
      },
      {
        heading: '就诊前可以准备什么',
        paragraphs: [
          '可以准备近期困扰、持续时间、不同场景的例子、既往评估资料和正在使用的药物清单。不要为了符合某个结果而改变回答。'
        ],
        points: []
      }
    ],
    sources: [SOURCES.niceRecommendations, SOURCES.cdcSymptoms],
    disclaimer: DEFAULT_DISCLAIMER
  },
  {
    id: 'treatment-decisions',
    categoryId: 'assessment',
    audiences: ['adult', 'child'],
    title: '如何参与治疗与支持决策',
    summary: '治疗和支持需要结合年龄、需求、环境、获益与风险，由本人或监护人与专业人员共同决定。',
    readMinutes: 5,
    updatedAt: '2026-08-21',
    sections: [
      {
        heading: '方案需要个体化',
        paragraphs: [
          'ADHD 支持可能包括环境调整、行为支持、心理干预、学校或工作场景支持，以及由专业人员评估后的药物治疗。适合的组合因年龄、功能影响、共存情况和个人偏好而异。'
        ],
        points: [
          '和专业人员讨论希望改善的具体困难。',
          '了解每种选择可能的获益、限制和需要监测的事项。',
          '定期回顾目标和实际变化。'
        ]
      },
      {
        heading: '药物安全',
        paragraphs: [
          '药物应由具备相应资质的专业人员评估和管理。不要根据网络信息自行开始、加减剂量或停药；如出现不适或疑问，应联系负责治疗的医疗人员。'
        ],
        points: []
      }
    ],
    sources: [SOURCES.cdcTreatment, SOURCES.niceOverview],
    disclaimer: DEFAULT_DISCLAIMER
  },
  {
    id: 'adult-organization',
    categoryId: 'support',
    audiences: ['adult'],
    title: '成人日常组织：把任务变得可见',
    summary: '用外部提醒、拆分步骤和环境调整降低遗忘与启动困难。',
    readMinutes: 4,
    updatedAt: '2026-08-21',
    sections: [
      {
        heading: '从一个小系统开始',
        paragraphs: [
          '与其同时更换所有习惯，可以先选择一个稳定入口记录任务，例如固定的清单或日历，并把大任务拆成能够立即开始的小步骤。'
        ],
        points: [
          '为重要物品设置固定位置。',
          '用可见计时器安排短时专注和休息。',
          '把提醒写成具体动作，而不是抽象目标。'
        ]
      },
      {
        heading: '观察而不是责备',
        paragraphs: [
          '记录哪些环境更容易完成任务，哪些干扰最明显。持续困难不代表缺乏努力；需要时可以向专业人员询问适合自己的支持方式。'
        ],
        points: []
      }
    ],
    sources: [SOURCES.nimhAdult, SOURCES.niceRecommendations],
    disclaimer: DEFAULT_DISCLAIMER
  },
  {
    id: 'family-support',
    categoryId: 'support',
    audiences: ['child'],
    title: '家庭支持：清晰、具体和一致',
    summary: '理解家长行为管理训练的目的，用结构和积极反馈支持孩子。',
    readMinutes: 5,
    updatedAt: '2026-08-21',
    sections: [
      {
        heading: '支持不是责备家长',
        paragraphs: [
          '家长支持和行为管理训练的目标，是帮助照护者掌握更适合孩子需要的沟通、结构和反馈方法，并不意味着“不好的养育”。'
        ],
        points: [
          '一次给出清晰、简短的指令。',
          '及时肯定具体的积极行为。',
          '让规则、后果和日常流程尽量一致。'
        ]
      },
      {
        heading: '寻求专业帮助',
        paragraphs: [
          '如果家庭压力很大或孩子的表现持续影响生活，可向儿科、儿童青少年精神心理专业人员咨询循证的家长训练和支持资源。'
        ],
        points: []
      }
    ],
    sources: [SOURCES.cdcParent, SOURCES.niceRecommendations],
    disclaimer: DEFAULT_DISCLAIMER
  },
  {
    id: 'school-support',
    categoryId: 'support',
    audiences: ['child'],
    title: '学校支持：家校共同观察与调整',
    summary: '通过清晰规则、环境调整和反馈协作，帮助孩子参与学习。',
    readMinutes: 4,
    updatedAt: '2026-08-21',
    sections: [
      {
        heading: '让支持落到具体场景',
        paragraphs: [
          '家长、教师和相关专业人员可以在取得适当同意后共享对学习与行为影响的观察，并讨论适合孩子的课堂和作业环境调整。'
        ],
        points: [
          '把长任务分成较短步骤并确认理解。',
          '减少座位周围不必要的干扰。',
          '使用及时、具体、可执行的反馈。',
          '定期沟通哪些方法有效，避免只在问题发生后联系。'
        ]
      },
      {
        heading: '调整需要个体化',
        paragraphs: [
          '不同孩子的学习特点和共存困难不同，学校支持应结合实际需要，并遵循当地教育和医疗专业建议。'
        ],
        points: []
      }
    ],
    sources: [SOURCES.cdcSchool, SOURCES.niceRecommendations],
    disclaimer: DEFAULT_DISCLAIMER
  }
])

function finiteCount(value, maximum) {
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(maximum, Math.round(value))
}

function statusLabel(status) {
  if (status === 'done') return '已完成'
  if (status === 'partial') return '进行中'
  return '待开始'
}

function createStep({ id, title, description, status, detail, actionLabel, actionUrl }) {
  return {
    id,
    title,
    description,
    status,
    statusLabel: statusLabel(status),
    detail,
    actionLabel,
    actionUrl
  }
}

function buildCarePathway(report, hasAccount = false) {
  const safeReport = report && typeof report === 'object' ? report : {}
  const scale = safeReport.scale && typeof safeReport.scale === 'object'
    ? safeReport.scale
    : {}
  const cognitive = safeReport.cognitive && typeof safeReport.cognitive === 'object'
    ? safeReport.cognitive
    : {}
  const tracking = safeReport.tracking && typeof safeReport.tracking === 'object'
    ? safeReport.tracking
    : {}
  const scaleDone = scale.hasData === true
  const cognitiveCount = finiteCount(cognitive.completedCount, 2)
  const trackingCount = finiteCount(tracking.completedCount, 14)
  const cognitiveDone = cognitiveCount === 2
  const trackingDone = trackingCount === 14
  const hasAnyData = scaleDone || cognitiveCount > 0 || trackingCount > 0
  const reportDone = scaleDone && cognitiveDone && trackingDone

  const steps = [
    createStep({
      id: 'account',
      title: '患者账号与基础信息',
      description: '建立患者身份和评估类型',
      status: hasAccount === true ? 'done' : 'pending',
      detail: hasAccount === true ? '患者账号已建立' : '请先完成注册与登录',
      actionLabel: hasAccount === true ? '已完成' : '返回登录',
      actionUrl: ''
    }),
    createStep({
      id: 'scale',
      title: '行为量表',
      description: '完成适合患者类型的标准化量表',
      status: scaleDone ? 'done' : 'pending',
      detail: scaleDone
        ? `${scale.scaleTypeLabel || '行为量表'}已完成`
        : '尚无完整量表结果',
      actionLabel: scaleDone ? '查看或重测' : '开始量表',
      actionUrl: '/pages/scale/index'
    }),
    createStep({
      id: 'cognitive',
      title: '认知测试',
      description: '完成 Go/No-Go 与 Stroop 两项任务',
      status: cognitiveDone ? 'done' : cognitiveCount > 0 ? 'partial' : 'pending',
      detail: `已完成 ${cognitiveCount} / 2 项`,
      actionLabel: cognitiveDone ? '查看结果' : '继续测试',
      actionUrl: '/pages/cognitive-center/index'
    }),
    createStep({
      id: 'tracking',
      title: '14天追踪',
      description: '连续记录睡眠、情绪、注意力和日常状态',
      status: trackingDone ? 'done' : trackingCount > 0 ? 'partial' : 'pending',
      detail: `已记录 ${trackingCount} / 14 天`,
      actionLabel: trackingDone ? '查看趋势' : '继续记录',
      actionUrl: '/pages/tracking/index'
    }),
    createStep({
      id: 'report',
      title: '综合辅助筛查报告',
      description: '汇总量表、认知与追踪信息',
      status: reportDone ? 'done' : hasAnyData ? 'partial' : 'pending',
      detail: reportDone
        ? '完整患者端报告已形成'
        : hasAnyData
          ? '可查看阶段性报告，继续补充数据会更完整'
          : '完成前序任务后生成阶段性报告',
      actionLabel: '查看报告',
      actionUrl: '/pages/report/index'
    })
  ]
  const completedCount = steps.filter((step) => step.status === 'done').length
  const currentStep = steps.find((step) => step.status !== 'done') || null

  return {
    steps,
    completedCount,
    totalCount: steps.length,
    percent: Math.round((completedCount / steps.length) * 100),
    complete: completedCount === steps.length,
    currentStep,
    sourceLabel: typeof safeReport.sourceLabel === 'string' && safeReport.sourceLabel.trim()
      ? safeReport.sourceLabel.trim()
      : '本地结果'
  }
}

function normalizePatientType(patientType) {
  return patientType === 'adult' || patientType === 'child'
    ? patientType
    : ''
}

function listEducationArticles(patientType, categoryId = 'all') {
  const normalizedType = normalizePatientType(patientType)
  const validCategory = EDUCATION_CATEGORIES.some((item) => item.id === categoryId)
  if (!normalizedType || !validCategory) return []

  return EDUCATION_ARTICLES.filter((article) => (
    article.audiences.includes(normalizedType) &&
    (categoryId === 'all' || article.categoryId === categoryId)
  ))
}

function getEducationArticle(articleId, patientType) {
  const normalizedType = normalizePatientType(patientType)
  if (!normalizedType || typeof articleId !== 'string') return null

  return EDUCATION_ARTICLES.find((article) => (
    article.id === articleId &&
    article.audiences.includes(normalizedType)
  )) || null
}

module.exports = {
  PATHWAY_STEP_IDS,
  EDUCATION_CATEGORIES,
  EDUCATION_ARTICLES,
  buildCarePathway,
  listEducationArticles,
  getEducationArticle
}
