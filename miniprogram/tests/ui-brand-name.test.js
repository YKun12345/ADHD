const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const miniRoot = path.resolve(__dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(miniRoot, relativePath), 'utf8')

const app = JSON.parse(read('app.json'))
const loginWxml = read('pages/login/index.wxml')
const homeWxml = read('pages/home/index.wxml')

assert.equal(
  app.window.navigationBarTitleText,
  'ADHD智慧辅助',
  '全局备用导航标题必须使用新品牌名'
)
assert.match(
  loginWxml,
  /<text class="title">ADHD智慧辅助<\/text>/,
  '登录页主品牌标题必须更新为 ADHD智慧辅助'
)
assert.match(
  loginWxml,
  /<text class="brand-kicker">ADHD SMART CARE<\/text>/,
  '登录页英文副标题必须与 ADHD 智慧辅助品牌统一'
)
assert.doesNotMatch(
  loginWxml,
  /brand-icon-shell|label="ADHD智慧辅助计划"/,
  '登录页不应继续渲染右上角圆形品牌图形'
)
assert.match(
  homeWxml,
  /<ui-nav\s+title="ADHD智慧辅助"\s+showBack="\{\{false\}\}"\s*\/>/,
  '首页导航必须使用新品牌名'
)
assert.doesNotMatch(
  `${loginWxml}\n${homeWxml}`,
  /专注健康|FOCUS HEALTH/,
  '登录页和首页不得残留旧品牌名'
)

console.log('品牌名称一致性测试全部通过')
