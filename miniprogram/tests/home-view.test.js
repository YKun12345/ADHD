const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const root = path.resolve(__dirname,'..'), view=fs.readFileSync(path.join(root,'pages/home/index.wxml'),'utf8')
const navigation=require('../utils/workspace-navigation')
assert.match(view, /<role-nav active-key="home"/)
assert.match(view, /<agent-actions/)
for(const section of ['assessments','records','communication']) assert.ok(view.includes('data-section="'+section+'"'))
assert.doesNotMatch(view, /今日任务|第\{\{currentDay\}\}天|class="footer-actions"/)
for(const key of ['privacy','notifications','server','queue']) {
 const url=navigation.entryUrl('patient','account',key,0)
 assert.ok(url)
 assert.ok(fs.existsSync(path.join(root,url.split('?')[0].slice(1)+'.js')))
}
console.log('用户首页导航与账号入口检查通过')
