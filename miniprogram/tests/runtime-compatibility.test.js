const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const miniprogramRoot = path.join(__dirname, '..')
const forbiddenPatterns = [
  { label: '.at(', pattern: /\.at\s*\(/ },
  { label: 'Object.hasOwn(', pattern: /Object\.hasOwn\s*\(/ },
  { label: '.finally(', pattern: /\.finally\s*\(/ }
]

function collectJavaScriptFiles(directory) {
  const files = []

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'tests') files.push(...collectJavaScriptFiles(fullPath))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath)
  }

  return files
}

const offenders = []
for (const filePath of collectJavaScriptFiles(miniprogramRoot)) {
  const source = fs.readFileSync(filePath, 'utf8')
  for (const forbidden of forbiddenPatterns) {
    if (forbidden.pattern.test(source)) {
      offenders.push(`${path.relative(miniprogramRoot, filePath)}: ${forbidden.label}`)
    }
  }
}

assert.deepEqual(
  offenders,
  [],
  `生产代码包含旧微信内核可能不支持的方法：\n${offenders.join('\n')}`
)

console.log('旧微信内核运行时兼容测试全部通过')
