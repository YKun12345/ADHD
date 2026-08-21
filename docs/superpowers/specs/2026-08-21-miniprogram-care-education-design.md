# 微信小程序临床路径与科普设计

日期：2026-08-21

## 1. 目标

完成 A 端 D12：提供一页可验证的患者辅助筛查路径，以及离线可读、来源透明的 ADHD 科普中心和文章详情。页面不把小程序筛查流程称为医学诊断，不把 B 尚未开始的影像、模型、DAC 或医生审核计入完成度。

## 2. 现有材料审查

网页版 `clinical_pathway.html` 有 8 个节点，其中影像分析和 DAC 安全审计属于 B，且完成文案会声称研究人员已收到报告，不适合迁移。网页版 `patient_education.html` 依赖外部图片及知乎、搜狐、百度等二次来源，也不适合作为离线比赛小程序的医学科普依据。

因此 D12 不复制网页实现，只参考“路径 + 科普”信息架构，重新建立 A-only 数据模型和权威来源。

## 3. 方案

采用“纯数据模块 + 路径页 + 科普列表页 + 文章详情页”：

- 路径页根据已有本地数据先显示，再尝试合并 `/patient/comprehensive_report`；
- 只统计账号、行为量表、两项认知、14 天追踪、综合报告 5 个 A 端节点；
- 各业务页不锁死，用户可随时进入补充；
- 科普正文随小程序打包，断网仍可阅读；
- 官方来源以名称和 URL 存入数据，点击只复制 URL，不使用未经配置的 `web-view`；
- 不使用远程图片，避免域名、版权和离线失败；
- 内容为权威资料的简短中文转述，不提供个体诊断或处方方案。

## 4. 权威来源

内容核对日期：2026-08-21。

- CDC ADHD 主题：`https://www.cdc.gov/adhd/index.html`
- CDC 症状：`https://www.cdc.gov/adhd/signs-symptoms/index.html`
- CDC 治疗概览：`https://www.cdc.gov/adhd/treatment/index.html`
- CDC 家长行为管理训练：`https://www.cdc.gov/adhd/treatment/behavior-therapy.html`
- CDC 学校支持：`https://www.cdc.gov/adhd/treatment/classroom.html`
- NIMH ADHD 概览：`https://www.nimh.nih.gov/health/topics/attention-deficit-hyperactivity-disorder-adhd`
- NIMH 成人 ADHD：`https://www.nimh.nih.gov/health/publications/adhd-what-you-need-to-know`
- NICE NG87：`https://www.nice.org.uk/guidance/ng87/`
- NICE NG87 建议：`https://www.nice.org.uk/guidance/ng87/chapter/recommendations`

来源只支持一般健康教育。页面统一提醒：诊断应由有资质的专业人员完成；量表和认知任务不能单独确诊；用药开始、调整或停止必须联系医生。

## 5. 数据模型

新增 `miniprogram/utils/care-education.js`，不访问 `wx`，导出：

- `PATHWAY_STEP_IDS`
- `EDUCATION_CATEGORIES`
- `EDUCATION_ARTICLES`
- `buildCarePathway(report, hasAccount)`
- `listEducationArticles(patientType, categoryId)`
- `getEducationArticle(articleId, patientType)`

### 5.1 路径完成规则

1. 账号：存在 `current_user` 时完成。
2. 行为量表：`report.scale.hasData` 时完成。
3. 认知测试：2 项完成为完成，1 项为进行中，0 项为待开始。
4. 14 天追踪：14 天完成为完成，1—13 天为进行中，0 天为待开始。
5. 综合报告：量表、2 项认知和 14 天追踪全部完成时为完成；存在任意患者端数据时为“可查看阶段性报告”；完全无数据时待开始。

进度只计算 `status === 'done'` 的节点。`currentStep` 为第一个未完成节点，返回推荐文案和白名单路由。服务端缺失不能清空本地合法结果。

### 5.2 科普文章

文章字段：

```js
{
  id,
  categoryId,
  audiences: ['adult', 'child'],
  title,
  summary,
  readMinutes,
  updatedAt,
  sections: [
    { heading, paragraphs: [], points: [] }
  ],
  sources: [
    { title, organization, url }
  ],
  disclaimer
}
```

第一版包含 6 篇：认识 ADHD、为什么需要专业评估、如何参与治疗决策、成人日常组织、家庭支持、学校支持。成人不显示只面向儿童家长的文章；儿童账号显示通用、家庭和学校内容。

## 6. 页面设计

### 6.1 临床路径 `pages/care-pathway/index`

- 本地报告立即构建路径；
- `onShow` GET `/patient/comprehensive_report` 后合并刷新；
- 接口失败保留本地路径，显示轻量离线提示；
- 展示完成数、百分比、来源和当前推荐步骤；
- 时间线逐项展示状态、判定依据和操作按钮；
- 路由只来自固定映射，不接受任意 URL；
- 底部单独说明专业评估、影像与医生结论尚未接入，不计入路径完成度。

### 6.2 科普中心 `pages/education/index`

- 根据患者类型展示适合文章；
- 分类为“全部 / 基础认识 / 评估就诊 / 日常支持”；
- 点击文章只传固定 `articleId`；
- 无远程图片、无接口依赖、无搜索引擎链接。

### 6.3 文章详情 `pages/education-detail/index`

- 只允许从内置白名单读取文章；
- 非法或不适合当前患者类型的 ID 显示提示并返回；
- 分节展示正文、要点、来源和医疗提示；
- 点击来源调用 `wx.setClipboardData`，只复制官方 URL；
- 不把 URL、文章或患者信息写入额外 storage。

## 7. 首页入口

成人和儿童快捷入口新增：

- `pathway`：我的路径，`/pages/care-pathway/index`
- `education`：科普中心，`/pages/education/index`

未知患者类型仍不可用。路径和科普不加入每日任务，避免把阅读当成强制筛查任务。

## 8. 测试

- 纯逻辑：空报告、局部/完整路径、完成度、当前步骤、非法计数、成人/儿童文章过滤、分类和非法文章 ID；
- 路径页：本地、服务端合并、离线、防重复刷新、白名单导航、返回；
- 科普列表：成人/儿童、分类、非法分类、打开文章、返回；
- 详情页：合法/非法/受众不符、复制来源、非法来源索引、返回；
- 视图：进度、时间线、状态、来源、分类、文章、来源复制、全部免责声明；
- 全量 Node 测试、全部 JS 语法、JSON 和 Git 差异边界。

## 9. 完成标准

- 五节点路径只反映可验证的 A 端数据；
- 科普中心离线可读并标明官方来源；
- 不出现个体诊断、处方或 B 端完成声明；
- 成人/儿童内容和入口正确；
- 自动测试全部通过，进度与工作日志已更新；
- 真机字体、长文滚动和复制链接由 D13 人工验收。
