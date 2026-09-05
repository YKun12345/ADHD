const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))

for (const page of ['pages/doctor-home/index', 'pages/doctor-patient/index', 'pages/doctor-guide-settings/index']) {
  assert.equal(appJson.pages.includes(page), true, `${page} 未注册`)
  for (const extension of ['js', 'json', 'wxml', 'wxss']) {
    assert.equal(
      fs.existsSync(path.join(root, `${page}.${extension}`)),
      true,
      `${page}.${extension} 不存在`
    )
  }
}

const loginView = fs.readFileSync(path.join(root, 'pages/login/index.wxml'), 'utf8')
assert.match(loginView, /data-role="patient"/)
assert.match(loginView, /data-role="researcher"/)

const doctorHomeView = fs.readFileSync(path.join(root, 'pages/doctor-home/index.wxml'), 'utf8')
const doctorHomeStyle = fs.readFileSync(path.join(root, 'pages/doctor-home/index.wxss'), 'utf8')
assert.match(doctorHomeView, /<onboarding-guide[^>]*bind:visibilitychange="onOnboardingVisibilityChange"/)
assert.match(doctorHomeView, /<ai-copilot\s+wx:if="\{\{!onboardingVisible\}\}"\s+page-key="doctor-home"/)
assert.match(doctorHomeView, /bindsubmit="bindPatient"/)
assert.match(doctorHomeView, /bindtap="openPatient"/)
assert.match(doctorHomeView, /bindinput="onSearchInput"/)
assert.match(doctorHomeView, /bindtap="selectRiskFilter"/)
assert.match(doctorHomeView, /bindtap="openPrivacySettings"/)
assert.doesNotMatch(doctorHomeView, /\.slice\(/)
assert.doesNotMatch(doctorHomeView, /<ui-nav[^>]*rightText="退出"/)
assert.match(doctorHomeView, /class="doctor-settings-entry"[\s\S]*class="logout-button"[\s\S]*bindtap="logout"/)
assert.match(doctorHomeStyle, /\.bind-card\s*\{[^}]*width:\s*100%[^}]*box-sizing:\s*border-box[^}]*overflow:\s*hidden/s)
assert.match(doctorHomeStyle, /\.bind-row\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s)
assert.match(doctorHomeStyle, /\.bind-input\s*\{[^}]*width:\s*0[^}]*min-width:\s*0/s)

const doctorSettingsView = fs.readFileSync(path.join(root, 'pages/doctor-guide-settings/index.wxml'), 'utf8')
assert.match(doctorSettingsView, /账号与隐私/)
assert.match(doctorSettingsView, /role="researcher"/)
assert.match(doctorSettingsView, /bindtap="reopenOnboarding"/)
assert.match(doctorSettingsView, /bindtap="restorePageGuides"/)
assert.match(doctorSettingsView, /bindchange="toggleAutoGuide"/)

const patientView = fs.readFileSync(path.join(root, 'pages/doctor-patient/index.wxml'), 'utf8')
const patientController = fs.readFileSync(path.join(root, 'pages/doctor-patient/index.js'), 'utf8')
assert.match(patientView, /bindsubmit="sendMessage"/)
assert.match(patientView, /bindsubmit="createTask"/)
assert.match(patientView, /bindfocus="onInputFocus"/)
assert.match(patientView, /bindblur="onInputBlur"/)
assert.match(patientView, /医生任务/)
assert.match(patientView, /<ai-copilot[^>]*page-key="doctor-patient"/)
assert.match(patientView, /careSummary/)
assert.match(patientView, /影像状态/)
assert.match(patientView, /模型结果/)
assert.match(patientView, /不替代医生诊断/)
assert.doesNotMatch(patientController, /setStorageSync|setStorage/)
assert.doesNotMatch(patientView, /上传影像|开始推理/)

const patientStyle = fs.readFileSync(path.join(root, 'pages/doctor-patient/index.wxss'), 'utf8')
assert.match(patientStyle, /\.send-button\s*\{[^}]*min-height:\s*88rpx/s)
assert.match(patientView, /class="send-button doctor-action-button task-submit"/)
assert.match(patientView, /class="send-button doctor-action-button"/)
assert.match(patientStyle, /\.doctor-action-button\s*\{[^}]*width:\s*360rpx[^}]*margin-left:\s*auto[^}]*margin-right:\s*auto/s)

console.log('医生端页面结构测试全部通过')
