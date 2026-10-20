const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('bundled product media stays within the WeChat 200 KiB recommendation', () => {
  const root = path.join(__dirname, '..', 'assets')
  const media = []
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (/\.(png|jpe?g|webp|gif|mp3|wav|m4a)$/i.test(entry.name)) media.push(file)
    }
  }
  walk(root)
  const bytes = media.reduce((sum, file) => sum + fs.statSync(file).size, 0)
  assert.ok(bytes <= 200 * 1024, `Bundled images/audio use ${bytes} bytes; budget is 204800 bytes`)
})
