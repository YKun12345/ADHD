const TOTAL_DAYS = 14

function normalizeCompletedDays(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return Array.from(
    new Set(
      value.filter(
        (day) =>
          Number.isInteger(day) &&
          day >= 1 &&
          day <= TOTAL_DAYS
      )
    )
  ).sort((left, right) => left - right)
}

function normalizeCurrentDay(value) {
  if (!Number.isInteger(value)) {
    return 1
  }

  return Math.min(TOTAL_DAYS, Math.max(1, value))
}

function normalizeDashboardStatus(payload = {}, source = 'server') {
  const safePayload = payload && typeof payload === 'object'
    ? payload
    : {}
  const completedDays = normalizeCompletedDays(
    safePayload.completed_days ?? safePayload.completedDays
  )
  const completedCount = completedDays.length
  const currentDay = normalizeCurrentDay(
    safePayload.current_day ?? safePayload.currentDay
  )
  const isLocal = source === 'local'

  return {
    currentDay,
    completedDays,
    completedCount,
    totalDays: TOTAL_DAYS,
    progressPercent: Math.round(
      (completedCount / TOTAL_DAYS) * 100
    ),
    dashboardSource: isLocal ? 'local' : 'server',
    sourceLabel: isLocal ? '本地计划' : '已同步'
  }
}

function createLocalDashboard(cache = {}) {
  return normalizeDashboardStatus(cache, 'local')
}

function getScaleAvailability(patientType) {
  if (patientType === 'adult' || patientType === 'child') {
    return {
      available: true,
      statusLabel: '开始评估',
      url: '/pages/scale/index'
    }
  }

  return {
    available: false,
    statusLabel: '按计划开发'
  }
}

function getCognitiveAvailability(patientType) {
  if (patientType === 'adult' || patientType === 'child') {
    return {
      available: true,
      statusLabel: '开始测试',
      url: '/pages/cognitive-center/index'
    }
  }

  return {
    available: false,
    statusLabel: '按计划开发'
  }
}

function getTrackingAvailability(patientType) {
  if (patientType === 'adult' || patientType === 'child') {
    return {
      available: true,
      statusLabel: '开始记录',
      url: '/pages/tracking/index'
    }
  }
  return { available: false, statusLabel: '按计划开发' }
}

function getReportAvailability(patientType) {
  if (patientType === 'adult' || patientType === 'child') {
    return {
      available: true,
      statusLabel: '查看报告',
      url: '/pages/report/index'
    }
  }
  return { available: false, statusLabel: '按计划开发' }
}

function getAiAvailability(patientType) {
  if (patientType === 'adult' || patientType === 'child') {
    return {
      available: true,
      statusLabel: '开始咨询',
      url: '/pages/ai-chat/index'
    }
  }
  return { available: false, statusLabel: '按计划开发' }
}

function getPathwayAvailability(patientType) {
  if (patientType === 'adult' || patientType === 'child') {
    return {
      available: true,
      statusLabel: '查看路径',
      url: '/pages/care-pathway/index'
    }
  }
  return { available: false, statusLabel: '按计划开发' }
}

function getEducationAvailability(patientType) {
  if (patientType === 'adult' || patientType === 'child') {
    return {
      available: true,
      statusLabel: '开始阅读',
      url: '/pages/education/index'
    }
  }
  return { available: false, statusLabel: '按计划开发' }
}

function getCareAvailability(patientType, page) {
  if (patientType === 'adult' || patientType === 'child') {
    return { available: true, statusLabel: '查看', url: page }
  }
  return { available: false, statusLabel: '按计划开发' }
}

function buildHomeTasks(patientType = '') {
  const scaleAvailability = getScaleAvailability(patientType)
  const cognitiveAvailability = getCognitiveAvailability(patientType)
  const trackingAvailability = getTrackingAvailability(patientType)

  return [
    {
      id: 'scale',
      icon: '量',
      title: '行为量表',
      description: '完成今日注意力行为评估',
      ...scaleAvailability
    },
    {
      id: 'cognitive',
      icon: '测',
      title: '认知测试',
      description: '完成反应力与注意力测试',
      ...cognitiveAvailability
    },
    {
      id: 'tracking',
      icon: '记',
      title: '每日追踪',
      description: '记录睡眠、情绪和用药情况',
      ...trackingAvailability
    }
  ]
}

function buildQuickEntries(patientType = '') {
  const scaleAvailability = getScaleAvailability(patientType)
  const cognitiveAvailability = getCognitiveAvailability(patientType)
  const trackingAvailability = getTrackingAvailability(patientType)
  const reportAvailability = getReportAvailability(patientType)
  const aiAvailability = getAiAvailability(patientType)
  const pathwayAvailability = getPathwayAvailability(patientType)
  const educationAvailability = getEducationAvailability(patientType)
  const messageAvailability = getCareAvailability(patientType, '/pages/patient-messages/index')
  const taskAvailability = getCareAvailability(patientType, '/pages/patient-tasks/index')

  return [
    {
      id: 'scale',
      icon: '量',
      title: '行为量表',
      ...scaleAvailability
    },
    {
      id: 'cognitive',
      icon: '测',
      title: '认知测试',
      ...cognitiveAvailability
    },
    {
      id: 'tracking',
      icon: '踪',
      title: '14天追踪',
      ...trackingAvailability
    },
    {
      id: 'report',
      icon: '报',
      title: '综合报告',
      ...reportAvailability
    },
    {
      id: 'ai',
      icon: '问',
      title: 'AI助手',
      ...aiAvailability
    },
    {
      id: 'pathway',
      icon: '路',
      title: '我的路径',
      ...pathwayAvailability
    },
    {
      id: 'education',
      icon: '知',
      title: '科普中心',
      ...educationAvailability
    },
    {
      id: 'doctor-tasks',
      icon: '任',
      title: '我的任务',
      ...taskAvailability
    },
    {
      id: 'messages',
      icon: '信',
      title: '医患消息',
      ...messageAvailability
    }
  ]
}

module.exports = {
  TOTAL_DAYS,
  normalizeDashboardStatus,
  createLocalDashboard,
  buildHomeTasks,
  buildQuickEntries
}
