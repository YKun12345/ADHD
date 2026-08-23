const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const PROTECTED_PAGES = [
  'home',
  'privacy-settings',
  'scale',
  'cognitive-center',
  'cognitive',
  'stroop',
  'tracking',
  'tracking-trend',
  'report',
  'ai-chat',
  'care-pathway',
  'education',
  'education-detail'
]

const PUBLIC_PAGES = [
  'login',
  'register',
  'server-settings'
]

function readPage(pageName) {
  return fs.readFileSync(
    path.join(__dirname, '..', 'pages', pageName, 'index.js'),
    'utf8'
  )
}

const protectedPageProblems = []
for (const pageName of PROTECTED_PAGES) {
  const source = readPage(pageName)
  const guardRequires = source.match(
    /^const \{ registerPatientPage \} = require\('\.\.\/\.\.\/utils\/patient-page'\)$/gm
  ) || []
  const guardedRegistrations = source.match(/^registerPatientPage\(\{/gm) || []
  const directRegistrations = source.match(/^Page\(\{/gm) || []

  if (guardRequires.length !== 1) {
    protectedPageProblems.push(
      `${pageName}: expected one exact patient-page require, found ${guardRequires.length}`
    )
  }
  if (guardedRegistrations.length !== 1) {
    protectedPageProblems.push(
      `${pageName}: expected one registerPatientPage({ call, found ${guardedRegistrations.length}`
    )
  }
  if (directRegistrations.length !== 0) {
    protectedPageProblems.push(
      `${pageName}: found ${directRegistrations.length} direct Page({ call(s)`
    )
  }
}

assert.deepEqual(
  protectedPageProblems,
  [],
  `Protected page wiring problems:\n${protectedPageProblems.join('\n')}`
)

const publicPageProblems = []
for (const pageName of PUBLIC_PAGES) {
  const source = readPage(pageName)
  const directRegistrations = source.match(/^Page\(\{/gm) || []

  if (directRegistrations.length !== 1) {
    publicPageProblems.push(
      `${pageName}: expected one direct Page({ call, found ${directRegistrations.length}`
    )
  }
  if (source.includes("require('../../utils/patient-page')")) {
    publicPageProblems.push(`${pageName}: must not require patient-page`)
  }
  if (/^registerPatientPage\(\{/m.test(source)) {
    publicPageProblems.push(`${pageName}: must not call registerPatientPage({`)
  }
}

assert.deepEqual(
  publicPageProblems,
  [],
  `Public page wiring problems:\n${publicPageProblems.join('\n')}`
)

console.log('患者页面保护接入测试全部通过')
