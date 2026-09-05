# Doctor UI Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the doctor-home rendering artifacts, align the two follow-up action buttons, and move logout from the top navigation to the bottom of the doctor home page.

**Architecture:** Keep the change local to the doctor home and doctor patient pages. Use static view tests to lock the WXML placement and WXSS containment/alignment rules while preserving the existing controller method for logout.

**Tech Stack:** WeChat Mini Program WXML/WXSS, Node.js built-in assertions and test runner

---

### Task 1: Add doctor UI regression assertions

**Files:**
- Modify: `miniprogram/tests/doctor-views.test.js`
- Test: `miniprogram/tests/doctor-views.test.js`

- [ ] **Step 1: Write the failing tests**

Add assertions that require the top navigation to omit logout, require a bottom logout control after the settings entry, require the bind form to have containment rules, and require both follow-up buttons to share a fixed width class:

```js
assert.doesNotMatch(doctorHomeView, /<ui-nav[^>]*rightText="退出"/)
assert.match(doctorHomeView, /class="doctor-settings-entry"[\s\S]*class="logout-button"[\s\S]*bindtap="logout"/)

const doctorHomeStyle = fs.readFileSync(path.join(root, 'pages/doctor-home/index.wxss'), 'utf8')
assert.match(doctorHomeStyle, /\.bind-card\s*\{[^}]*width:\s*100%[^}]*box-sizing:\s*border-box[^}]*overflow:\s*hidden/s)
assert.match(doctorHomeStyle, /\.bind-row\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s)

assert.match(patientView, /class="send-button doctor-action-button task-submit"/)
assert.match(patientView, /class="send-button doctor-action-button"/)
assert.match(patientStyle, /\.doctor-action-button\s*\{[^}]*width:\s*360rpx[^}]*margin-left:\s*auto[^}]*margin-right:\s*auto/s)
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node miniprogram/tests/doctor-views.test.js`

Expected: FAIL because `.bind-card` lacks the containment rules and the shared `doctor-action-button` class does not exist.

- [ ] **Step 3: Commit the failing regression test**

```bash
git add miniprogram/tests/doctor-views.test.js
git commit -m "test: cover doctor UI alignment"
```

### Task 2: Contain the bind form and keep logout at the bottom

**Files:**
- Modify: `miniprogram/pages/doctor-home/index.wxml`
- Modify: `miniprogram/pages/doctor-home/index.wxss`
- Test: `miniprogram/tests/doctor-views.test.js`

- [ ] **Step 1: Keep the page-local logout structure**

The navigation and bottom controls must have this structure:

```xml
<ui-nav title="医生工作台" showBack="{{false}}" />
...
<view class="doctor-settings-entry" ... bindtap="openPrivacySettings">账号与隐私</view>
<view class="logout-button" hover-class="logout-button--pressed" aria-role="button" bindtap="logout">退出登录</view>
```

- [ ] **Step 2: Add minimal containment styles**

Use explicit border-box sizing and clipping on the form, and prevent the flex row/input from overflowing:

```css
.bind-card {
  width: 100%;
  box-sizing: border-box;
  overflow: hidden;
  margin-top: 26rpx;
  padding: 30rpx;
  border-radius: 28rpx;
  background: rgba(255, 255, 255, 0.86);
}
.bind-row { display: flex; width: 100%; min-width: 0; gap: 14rpx; margin-top: 22rpx; }
.bind-input { flex: 1; width: 0; min-width: 0; height: 88rpx; box-sizing: border-box; padding: 0 24rpx; border: 1rpx solid #ced9e7; border-radius: 20rpx; color: #263e5d; background: #f7f9fc; }
```

- [ ] **Step 3: Run the focused test**

Run: `node miniprogram/tests/doctor-views.test.js`

Expected: still FAIL only on the shared follow-up button assertions.

- [ ] **Step 4: Commit the doctor home fix**

```bash
git add miniprogram/pages/doctor-home/index.wxml miniprogram/pages/doctor-home/index.wxss
git commit -m "fix: contain doctor home form and relocate logout"
```

### Task 3: Align follow-up action buttons

**Files:**
- Modify: `miniprogram/pages/doctor-patient/index.wxml`
- Modify: `miniprogram/pages/doctor-patient/index.wxss`
- Test: `miniprogram/tests/doctor-views.test.js`

- [ ] **Step 1: Apply one shared class to both actions**

```xml
<button class="send-button doctor-action-button task-submit" ...>下发任务</button>
<button class="send-button doctor-action-button" ...>发送消息</button>
```

- [ ] **Step 2: Add one shared geometry rule**

```css
.doctor-action-button {
  width: 360rpx;
  min-width: 0;
  margin-left: auto;
  margin-right: auto;
}
.task-submit { margin-top: 16rpx; }
```

- [ ] **Step 3: Run the focused test and verify GREEN**

Run: `node miniprogram/tests/doctor-views.test.js`

Expected: PASS.

- [ ] **Step 4: Run all Mini Program tests**

Run: `node --test miniprogram/tests/*.test.js`

Expected: all tests pass with zero failures.

- [ ] **Step 5: Check the final diff**

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 6: Commit the follow-up alignment fix**

```bash
git add miniprogram/pages/doctor-patient/index.wxml miniprogram/pages/doctor-patient/index.wxss
git commit -m "fix: align doctor follow-up actions"
```
