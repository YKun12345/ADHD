# 医生端影像显示修复验证（2026-10-07）

## 故障与修复

上传成功后，`doctor-web/js/doctor_visualization.js` 使用 `../findviz/...` 动态导入查看器。模块路径相对于 JavaScript 文件解析，实际请求落到不存在的 `/doctor-web/findviz/static/js/viewer/MainViewer.js`，返回 404，因此 NIfTI 和 GIfTI 工作区均为空。

改为 `../../findviz/...`，对应实际挂载的 `/findviz/static/js/viewer/MainViewer.js`。同时将主查看器和分析查看器中的 `moviePopover.js`、`TimeCourse.js` 引用改为仓库实际的 `MoviePopover.js`、`timecourse.js`，保证区分大小写的部署环境可加载。页面模块版本号更新为 `20261007a`。

## 自动验证

- 新增 `backend/tests/test_findviz_web.py`：从医生页面入口递归解析静态与动态模块引用，逐个检查 HTTP 200、JavaScript MIME 类型和文件名大小写。
- 使用合成 `.nii.gz` 和左右半球 `.func.gii` / `.surf.gii`，经真实上传接口检查缓存就绪、非空二维切片、有限强度值、顶点坐标和合法三角面索引。
- 修复前模块依赖测试明确失败：`/doctor-web/findviz/static/js/viewer/MainViewer.js: HTTP 404`。
- `python -m pytest backend/tests -q`：62 passed；补强数据形状与网格断言后，影像专项测试再次执行：3 passed。
- `python -m unittest tests.test_web_dependency_audit -q`：3 tests，OK。
- 三个修改的 JavaScript 文件均通过 `node --check`；新增测试通过 Ruff；修改文件通过 `git diff --check`。
- 测试输出包含既有 WSGI 弃用提示，以及无外部时间序列输入时的 All-NaN 范围提示；本次未修改这些代码。

## 浏览器验证

Tabbit 在隔离的本地 8001 端口运行应用，使用临时 SQLite 和合成影像文件；患者列表仅提供合成测试上下文，影像上传、缓存、元数据、绘图和控制接口均使用实际服务。

已验证：

1. NIfTI 上传后显示三个方向的 heatmap 切片、十字线和彩条。
2. GIfTI 上传后显示左右半球 mesh3d 和彩条。
3. GIfTI 时间点滑块使实际绘图强度更新；色图和颜色反转成功更新图形。
4. 同一页面连续执行 NIfTI → GIfTI → NIfTI 上传，切换成功。
5. NIfTI 正交 / 蒙太奇视图切换成功。
6. 上述浏览器操作未捕获到 pageerror。

截图仅用于证明渲染链路：NIfTI 为合成随机体数据，GIfTI 为合成八面体，不是真实患者脑影像。

- [NIfTI 截图](synthetic-nifti.png)
- [GIfTI 截图](synthetic-gifti.png)

本次没有使用用户截图中的原始影像文件，也没有验证截图保存回实际患者报告的流程。

## 使用方式

原有 `http://127.0.0.1:8000` 服务已核对：医生页面和入口模块提供更新后的版本，`MainViewer.js`、`MoviePopover.js`、`timecourse.js` 均返回 HTTP 200 和正确内容类型。

在原后端服务上的医生页面按 `Ctrl + F5` 刷新，再从患者工作台进入影像可视化、重新选择文件并点击对应的“进入可视化”按钮。本次修改的是静态前端模块，无需数据库迁移。

## 项目阅读范围

按目录盘点并完成自有文本内容阅读：

| 目录 | 覆盖范围 |
| --- | --- |
| `backend/` | 99 个文件，包含接口、服务、模型、schema、SQL、脚本、文档和测试 |
| `miniprogram/` | 272 个文件，包含页面、组件、工具、入口配置和 99 个测试及辅助文件 |
| `doctor-web/` | 24 个文本文件，包含所有页面、业务脚本和样式 |
| `patient-web/` | 31 个文本文件，包含所有页面、业务脚本和样式 |
| `archive/` | 27 个文本文件；README 已读，其余 26 个与当前患者网页对应文件 SHA256 相同，按内容相同的副本覆盖 |
| `findviz/` | 130 个自有文件：51 个 Python、61 个 JavaScript、17 个 HTML 模板和 1 个 CSS |

同时阅读了 `HGST-main/` 的训练、数据准备、超图构建与模型源码，以及根目录说明和依赖配置、Docker/部署配置、`scripts/`、`tools/`、根目录测试和 `docs/` 文本记录。大型 JSON 数据与生成记录已解析结构；完全相同的 API、样式和归档副本只阅读一份，并核对差异。

第三方库、图片/字体、模型二进制及构建产物按文件清单核对，不作为自有源码逐行阅读。实际密钥环境文件、数据库、上传数据和运行缓存未读取。

整体关系为：医生网页通过 findviz 解析并显示 NIfTI/GIfTI；后端保存截图、文件信息与解读，患者网页和小程序从综合报告展示这些结果。HGST 的时间序列分类预测为另一条接口链路。全项目核对未发现需要扩大本次显示修复的其他阻断。
