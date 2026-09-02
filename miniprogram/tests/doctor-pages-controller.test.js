const assert = require('node:assert/strict')

const calls = {
  requests: [],
  toasts: [],
  navigateTo: [],
  navigateBack: [],
  reLaunch: []
}
let requestImplementation = async () => ({})
let pageDefinition
const storage = {
  access_token: 'doctor-token',
  current_user: {
    id: 3,
    role: 'researcher',
    full_name: '李医生'
  }
}

const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = {
  id: requestPath,
  filename: requestPath,
  loaded: true,
  exports: {
    request(options) {
      calls.requests.push(options)
      return requestImplementation(options)
    }
  }
}

global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  removeStorageSync(key) {
    delete storage[key]
  },
  showToast(options) {
    calls.toasts.push(options)
  },
  navigateTo(options) {
    calls.navigateTo.push(options)
  },
  navigateBack(options) {
    calls.navigateBack.push(options)
  },
  reLaunch(options) {
    calls.reLaunch.push(options)
  }
}

global.Page = (definition) => {
  pageDefinition = definition
}

function createPage(definition) {
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) {
      this.data = { ...this.data, ...patch }
    }
  }
}

async function run() {
  require('../pages/doctor-home/index')
  const homeDefinition = pageDefinition
  const home = createPage(homeDefinition)
  requestImplementation = async (options) => {
    if (options.url === '/doctor/dashboard_stats') {
      return { patient_count: 1, pending_imaging_count: 0, weekly_report_count: 2 }
    }
    if (options.url === '/doctor/my_patients') {
      return {
        total: 1,
        items: [{
          patient_id: 8,
          patient_name: '患者甲',
          patient_email: 'patient@example.com',
          completed_tracking_days: 6,
          cognitive_test_count: 3
        }]
      }
    }
    if (options.url === '/care/doctor/patient/8/summary') return { unread_message_count: 2, pending_task_count: 1 }
    if (options.url === '/doctor/bind_patient') return { patient_id: 8 }
    throw new Error(`unexpected request: ${options.url}`)
  }

  home.onLoad()
  assert.equal(home.data.doctorName, '李医生')
  await home.onShow()
  assert.equal(home.data.stats.patientCount, 1)
  assert.equal(home.data.patients[0].patientId, 8)
  assert.equal(home.data.careTotals.unread, 2)
  assert.equal(home.data.careTotals.pending, 1)

  home.openPatient({ currentTarget: { dataset: { id: 8 } } })
  assert.deepEqual(calls.navigateTo, [{
    url: '/pages/doctor-patient/index?patient_id=8'
  }])

  home.setData({ bindEmail: ' PATIENT@EXAMPLE.COM ' })
  await home.bindPatient()
  const bindRequest = calls.requests.find((item) => item.url === '/doctor/bind_patient')
  assert.deepEqual(bindRequest, {
    url: '/doctor/bind_patient',
    method: 'POST',
    data: { patient_email: 'patient@example.com' }
  })
  assert.equal(home.data.bindEmail, '')

  require('../pages/doctor-patient/index')
  const patientDefinition = pageDefinition
  const patient = createPage(patientDefinition)
  calls.requests = []
  requestImplementation = async (options) => {
    if (options.url === '/doctor/patient/8/report') {
      return {
        patient_id: 8,
        patient_name: '患者甲',
        patient_email: 'patient@example.com',
        care_summary: ['规律随访'],
        suggested_actions: ['一周后复测']
      }
    }
    if (options.url === '/care/doctor/patient/8/messages' && options.method === 'POST') {
      return {
        id: 11,
        sender_role: 'researcher',
        content: options.data.content,
        created_at: '2026-09-01T08:00:00Z'
      }
    }
    if (options.url === '/care/doctor/patient/8/messages') return { items: [] }
    if (options.url === '/care/doctor/patient/8/tasks' && !options.method) return { items: [] }
    if (options.url === '/care/doctor/patient/8/ai_logs') return { items: [{ id: 4, role: 'user', scope: 'report', content: '解释报告', created_at: '2026-09-01T08:00:00Z' }] }
    if (options.url === '/care/doctor/patient/8/tasks' && options.method === 'POST') {
      return { id: 21, task_type: options.data.task_type, task_title: options.data.task_title, status: 'pending', due_at: options.data.due_at }
    }
    throw new Error(`unexpected request: ${options.url}`)
  }

  await patient.onLoad({ patient_id: '8' })
  assert.equal(patient.data.report.patientName, '患者甲')
  assert.equal(patient.data.messages.length, 0)
  assert.equal(patient.data.tasks.length, 0)
  assert.equal(patient.data.aiLogs.length, 1)
  patient.setData({ messageInput: '  请一周后复测  ' })
  await patient.sendMessage()
  const messageRequest = calls.requests.find((item) => item.url === '/care/doctor/patient/8/messages' && item.method === 'POST')
  assert.match(messageRequest.data.client_message_id, /^wx-/)
  assert.equal(patient.data.messages.length, 1)
  assert.equal(patient.data.messages[0].content, '请一周后复测')
  assert.equal(patient.data.messageInput, '')

  patient.setData({ taskType: 'tracking', taskTitle: '每日记录', taskDescription: '连续记录', taskDueDate: '2026-09-08' })
  await patient.createTask()
  assert.equal(patient.data.tasks.length, 1)
  assert.equal(patient.data.tasks[0].title, '每日记录')

  calls.requests = []
  const invalidPatient = createPage(patientDefinition)
  invalidPatient.onLoad({ patient_id: '8x' })
  assert.equal(calls.requests.length, 0)
  assert.equal(calls.navigateBack.length, 1)

  console.log('医生工作台与患者详情控制逻辑测试全部通过')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
