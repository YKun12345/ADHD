# 连线轨迹与认知任务随机化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为连线任务增加实时可视路径和每轮随机节点布局，并验证七类认知任务不会暴露可死记的固定呈现序列。

**Architecture:** 在 `trail-test.js` 中提供纯函数随机布局与路径线段模型，页面控制器只负责调用和 Canvas 绘制。其他任务保留已有受约束生成器，通过统一契约测试确认随机性不破坏题型比例。

**Tech Stack:** 微信原生小程序 JavaScript/WXML/WXSS Canvas、Node `node:test`。

---

### Task 1: 路径模型与随机布局

**Files:**
- Modify: `miniprogram/utils/trail-test.js`
- Modify: `miniprogram/tests/trail-test.test.js`

- [x] 写失败测试，要求随机布局接口和路径线段接口存在。
- [x] 验证测试因接口缺失失败。
- [x] 实现 `createRandomTrailLayout` 和 `buildTrailPath`。
- [x] 验证不同随机样本产生不同布局，错误/未完成节点不生成额外线段。

### Task 2: Canvas 连接轨迹

**Files:**
- Modify: `miniprogram/pages/trail/index.js`
- Modify: `miniprogram/pages/trail/index.wxml`
- Modify: `miniprogram/pages/trail/index.wxss`
- Modify: `miniprogram/tests/new-cognitive-views.test.js`

- [x] 写失败视图测试，要求 Canvas 覆盖层、随机布局说明和不拦截点击样式。
- [x] 页面开始阶段使用随机布局并清空轨迹。
- [x] 正确点击后根据已完成节点绘制路径；错误点击只累计错误。
- [x] 验证休息、结果和重新开始不会保留旧轨迹。

### Task 3: 全任务随机化契约

**Files:**
- Create: `miniprogram/tests/cognitive-randomization.test.js`

- [x] 验证反应抑制、简单反应时、颜色干扰、箭头抗干扰、两步位置记忆、数字广度和连线布局在不同随机源下发生变化。
- [x] 同时验证目标比例、相容比例、方向平衡、跨度顺序等测量约束不变。
- [x] 运行认知专项测试和 `node --test miniprogram/tests/*.test.js`。
- [x] 运行 `git diff --check`，不提交、不合并、不上传。
