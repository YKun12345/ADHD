# 认知任务与14天趋势实际页面验收

验收日期：2026-10-04。截图由本机微信开发者工具的真实小程序模拟器导出，视口 **390 × 844，DPR 3**。没有使用网页重建图代替微信页面截图。

## 趋势调查与修复

用户提供的两张截图中，曲线、网格和纵轴整体位于卡片上方，卡片为 Canvas 留出的区域却为空白。现有代码已设置 DPR，不能将问题归结为“没有处理 DPR”。本机当前环境的 `native-baseline-*.png` 没有稳定复现历史整体上移，因此未声称已证明某一微信原生层故障。

代码中确认的问题是日期标签独立横向排版，未采用曲线绘图区的留白和第7天的 6/13 横坐标；`Number(null)`、空串和布尔值会变为0；页面隐藏和尺寸变化后的绘制失效处理不完整。

本次将 Canvas 放入拥有固定高度和相对定位的独立绘图区，Canvas 从局部左上角绝对定位，显示宽高显式使用绘图区测得的 CSS 像素；物理位图宽高单独按 DPR 换算。每次重绘先重置变换并清除整个位图，再应用逻辑坐标变换。曲线、网格、纵轴与日期刻度共用绘图区，保留缺失日期断线。滚动、尺寸变化和重新显示会重新测量，旧指标、隐藏页和旧会话回调失效。

`native-final-geometry.json` 中，绘图区与 Canvas 的显示边界相同：top 401.17、bottom 629.17；卡片范围为 top 280、bottom 679，摘要文字在 top 377.67—393.17。绘图边界位于摘要下方和卡片内部。

| 实际截图 | 目视检查结果 |
| --- | --- |
| `native-final-mood.png`、`native-final-attention.png`、`native-final-focus.png` | 三个指标的曲线、点、网格及刻度均在卡片内；指标、单位与均值同步变化；日期标签位于同一绘图区底部。 |
| `native-fixed-focus-after-return.png` | 从每日追踪页返回后，当前专注指标仍正确绘制。 |
| `native-fixed-missing-mood.png`、`native-fixed-missing-attention.png`、`native-fixed-missing-focus.png` | 临时演示样例中的缺失日期、空字段保持断线；实际记录的0分钟保留；专注值0、60、120的均值为60分钟。样例只写入模拟器，结束后恢复原存储。 |
| `native-fixed-focus-after-scroll.png` | 调用实际页面滚动接口后截取。当前390×844视口的趋势内容可完整显示，滚动范围有限；该图不能证明小屏大距离滚动已验收。 |

## 任务实际页面检查

- `native-{cognitive,stroop,flanker,nback,trail,digit-span}-battery-instructions.png`：六项完整评估入口均立即显示各自说明，实际页面状态均为弹窗可见、按钮未就绪、任务未运行。
- `native-nback-instructions-countdown.png`：3秒阅读按钮置灰；尝试直接启动仍未运行。
- `native-nback-instructions-ready.png`：倒计时结束后按钮可用，任务仍等待主动开始。
- `native-nback-first-yellow.png`：第1次为黄色，仅显示记忆提示，没有匹配按钮；等待2.2秒仍为第1次。
- `native-nback-third-judgment.png`：实际点击前两次黄色方格后，第3次呈现原绿色及匹配/不匹配按钮。
- `native-cognitive-full-green.png`、`native-cognitive-full-red.png`、`native-cognitive-white-*.png`：背景覆盖整个测试页面，不出现旧卡片边距或圆角；绿色点击后恢复白色；红色不点击等待结束记正确并恢复白色。

**反应抑制截图方法限制：** 截图接口耗时可能超过800毫秒刺激窗口，因此只在截取绿色、红色稳定视觉状态时暂停模拟器中的刺激计时器，并将首两轮设置为GO、NO-GO。随后重新启用真实800毫秒NO-GO计时，验证不点击的正确记录和自动白色。静态截图不能证明真实人类反应时测量；生产随机顺序与时限未因验收脚本改变。

## 连线实际页面检查

- `native-trail-A-30-nodes.png`：A的30个数字节点，实际显示尺寸40 × 40 CSS px，清晰可读。
- `native-trail-A-connected-path.png`：实际点击前12个正确节点后连接路径已显示。
- `native-trail-A-to-B-transition.png`：实际连接到30后出现简短B规则提示，不显示开始B按钮。验收发现A结束时保留旧滚动位置会遮挡标题，随后已修复并重新截取，现标题和规则完整可见。
- `native-trail-B-30-nodes.png`：提示2秒后自动进入B，15组、30节点，包含15与O。
- `native-trail-A-geometry.json`、`native-trail-B-geometry.json`：对实际测得的30个节点逐一检查，均完整位于棋盘内，任意两个节点矩形不重叠。

只完成了A阶段，未完成B或提交认知结果。阶段过渡和A节点点击使用实际任务方法。

## 自动回归与未覆盖范围

本轮针对性回归包含 tracking-trend、tracking-trend-page、canvas-scale、report-page、report-data、ui-report-tracking、tracking-page、tracking-view，均通过。页面坐标回归覆盖宽240、320、428以及非整数319.5 CSS px，高190—280 CSS px，DPR 1、2、3、2.75；验证清除物理像素、日期与数据共用横坐标、点和标签位于局部边界、指标切换与生命周期的旧回调失效。

这些尺寸和像素密度是**自动坐标回归**，不是多个真实手机截图。实际原生截图只覆盖390×844、DPR3。仍需在不同尺寸和像素密度的真实微信手机上检查长页面滚动、切换和重新进入；历史整体上移的特定环境也需复核。

## 复验工具与数据保护

`tools/trend-native-check.cjs` 连接已打开项目的微信开发者工具自动化 WebSocket `ws://127.0.0.1:9420`。需要可解析的 `ws` 模块；可以正常 `require('ws')`，或通过 `WECHAT_AUTOMATION_WS_MODULE` 指定已安装模块的绝对路径。脚本不依赖另一项目的目录名，不安装或变更项目依赖。

可执行 `node tools/trend-native-check.cjs final`、`tasks`、`trail` 或 `instructions`。`baseline` 模式应在修复前运行，已经保存的baseline截图来自本次修改前的真实页面。

验收期间所有 `wx.request` 被模拟以阻止真实服务写入。原始模拟器存储只备份到进程内存，结束时恢复全部键和值，最后一轮验收逐键检查恢复等价并移除请求模拟。没有将患者标识、令牌或原始存储备份写入证据文件。截图、几何记录和工具本身可以保留。
