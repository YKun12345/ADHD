# 智绘脑图全角色 Android App 设计说明

## 目标

在完全不修改原网站 HTML、CSS、JavaScript 和后端源码的前提下，把现有网站封装为可安装的 Android App。App 保留患者、研究人员/医生和 DAC 三类角色，登录后继续使用原有身份分流逻辑。

第一阶段交付可在华为畅享 10（HarmonyOS 3.0）上安装和调试的 APK。后端继续运行在电脑上，手机与电脑通过同一局域网通信。

## 已确认约束

- 原网站是只读来源。根目录中的 `*.html`、`*.htm`、`css/`、`js/`、`findviz/` 和 `backend/` 不允许被移动端构建过程改写。
- 所有移动端文件放在独立的 `mobile-app/` 目录。
- App 包含全部角色页面，不只包含患者端。
- FastAPI、数据库、Qwen、HGST 和 Findviz 服务不放进 APK，仍由电脑或以后部署的服务器提供。
- 当前局域网 HTTP 仅用于开发测试；正式发布时必须改成稳定的 HTTPS 服务地址。

## 方案比较与选择

### 方案 A：直接在原网站中加入 Capacitor

优点是文件少；缺点是会修改原站的依赖、页面和配置，容易影响学姐的网站。此方案不采用。

### 方案 B：完整复制一套网站后人工维护

优点是相互隔离；缺点是以后原网站更新时容易漏同步，两个版本会逐渐分叉。此方案不采用。

### 方案 C：独立移动端工程 + 自动生成只读副本

`mobile-app/` 保存 Capacitor、Android、移动端配置和构建脚本。每次构建时，脚本从原站复制页面与静态资源到 `mobile-app/www/`，随后只修改副本。构建前后对原站文件计算哈希并验证未变化。

采用方案 C，因为它同时保证原站安全、App 可独立维护，并能继续吸收原网站以后的更新。

## 总体架构

```text
原网站（只读）
  ├─ HTML / CSS / JS
  ├─ Findviz 静态资源与模板
  └─ FastAPI 后端源码
            │
            │ 复制 + 副本转换 + 原文件哈希校验
            ▼
mobile-app/www（生成目录）
  ├─ 全角色网页副本
  ├─ 本地第三方前端资源
  ├─ 移动端服务器设置页
  └─ 移动端运行时配置和覆盖样式
            │
            │ Capacitor sync
            ▼
mobile-app/android
            │
            ▼
Android APK ──局域网 HTTP──> 电脑 FastAPI :8000
```

## 文件边界

### 新建且可修改

- `mobile-app/package.json`：移动端依赖和构建命令。
- `mobile-app/capacitor.config.*`：App ID、名称、Web 资源目录和 Android WebView 配置。
- `mobile-app/src/`：资源复制、页面转换、地址规范化与生成默认地址的脚本。
- `mobile-app/overrides/`：移动端入口页、设置界面、覆盖样式和运行时脚本。
- `mobile-app/tests/`：配置、复制、页面注入和原站完整性测试。
- `mobile-app/www/`：每次构建重新生成的网页副本。
- `mobile-app/android/`：Capacitor 生成的 Android 工程。
- `mobile-app/README.md`：启动后端、同步、构建、安装和故障排查说明。

### 原站只读区域

- 根目录全部 `*.html` 与 `*.htm` 文件。
- `css/`、`js/`。
- `findviz/static/`、`findviz/templates/`。
- `backend/` 及其他模型、数据处理目录。

构建脚本只允许读取这些路径。测试会在同步前后比较哈希，发现变化立即失败。

## 页面与角色范围

App 打包以下内容：

- 登录/注册页。
- 全部 `patient_*.html` 页面和临床路径页。
- 全部 `doctor_*.html` 页面、模型训练流程和相关说明页面。
- DAC 控制台与安全加密页面。
- Findviz 前端静态资源和 HTML 模板。

登录后沿用现有逻辑：

- `patient` 进入 `patient_home.html`。
- 普通 `researcher` 进入 `doctor_analysis.html`。
- `researcher + dac` 进入 `dac_dashboard.html`。

不在 App 中复制 Python 后端、数据库或模型权重。

## 移动端服务器配置

网页中的 `127.0.0.1:8000` 在手机上代表手机自身，因此 App 必须使用电脑的局域网 IPv4 地址。

移动端运行时提供以下能力：

1. 第一次打开 App 时显示服务器设置页。
2. 默认建议当前构建电脑的局域网地址，例如 `http://192.168.1.8:8000`。
3. 用户可修改地址并点击“测试连接”。
4. App 请求 `<服务器地址>/api/v1/health`，仅在返回 `{"status":"ok"}` 后保存。
5. 地址保存到 App WebView 的本地存储，后续打开直接进入登录页。
6. 登录页和主要页面保留“服务器设置”入口，电脑 IP 改变后可以重新配置。

运行时在原有 `js/api.js` 加载前设置：

- `window.SMARTBRAIN_API_BASE_URL = '<服务器地址>/api/v1'`
- `window.FINDVIZ_BASE_PATH = '<服务器地址>/findviz'`

这些变量只注入到 `mobile-app/www` 的页面副本。

## Findviz 适配

Findviz 的模板、JavaScript、CSS 和 vendor 文件作为本地静态资源进入 APK，所以页面本身可以离线加载。上传、缓存、预处理和绘图 API 仍指向电脑的 `/findviz` 服务。

副本构建时只修改复制后的 Findviz API 常量模块，使所有相对接口通过 `window.FINDVIZ_BASE_PATH` 指向配置的服务器。原 `findviz/` 目录不变。

## 第三方前端资源

登录页和业务页面依赖 Ionicons、ECharts 和 Inter 字体。为避免 App 打开时受 Google Fonts、unpkg 或 jsDelivr 网络状态影响，移动端工程安装对应前端包，并在副本中把这些 CDN 引用替换为 `mobile-app/www/vendor/` 下的本地文件。

科普页面中的外部文章和图片仍需要互联网。外部链接由系统浏览器打开，避免离开 App 的内部导航栈。

## Android 配置

- 技术：Capacitor 8 + Android 原生工程。
- App 名称：`智绘脑图`。
- 应用 ID：`com.smartbrainmap.app`。
- 最低系统由 Capacitor 8 默认值控制，覆盖华为畅享 10 对应的 Android 版本。
- Android Manifest 包含互联网权限。
- 开发测试允许访问局域网明文 HTTP，并允许 WebView 的 HTTPS 本地来源请求 HTTP 后端。
- 正式发布配置不得继续使用宽松明文 HTTP；发布前切换 HTTPS 并收紧网络安全配置。
- Android 返回键优先执行网页历史返回；无历史且位于入口时再退出 App。

## 后端运行方式

不修改 `backend/app/main.py`。开发时从项目根目录运行：

```powershell
python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
```

`--host 0.0.0.0` 使同一局域网中的手机能够访问。首次启动如出现 Windows 防火墙提示，只允许专用网络。现有 CORS 允许 Capacitor 默认的 `https://localhost` 来源，因此第一阶段无需改后端源码。

## 错误处理

- 地址为空、不是 `http://` 或 `https://`、含无效路径时，设置页给出明确中文提示。
- 健康检查超时或失败时不保存地址，并提示检查同一 Wi-Fi、后端服务和防火墙。
- 业务请求失败时保留现有页面提示，同时移动端设置入口始终可用。
- 原站哈希变化、必要页面缺失或副本注入失败时终止构建，不生成不完整 APK。
- Findviz 本地模板缺失时构建测试失败；后端 Findviz 不可达时页面显示服务器连接提示。

## 测试与验收

### 自动测试

- 服务器地址规范化：尾部斜杠、API 路径、非法协议和空值。
- 健康检查 URL 生成。
- 全角色页面均被复制。
- 每个复制页面都在原业务脚本之前加载移动端运行时配置。
- CDN 核心资源已改为本地路径。
- Findviz API 常量仅在副本中被转换。
- 同步前后原站文件哈希完全一致。
- Capacitor `sync` 成功。
- Android Debug APK 构建成功。

### 华为真机验收

- `adb devices -l` 显示华为设备状态为 `device`。
- APK 能安装并打开。
- 首次启动能测试并保存电脑服务器地址。
- 患者、研究人员和 DAC 登录后分别进入正确页面。
- 患者量表、测试、追踪、报告和 AI 请求可到达后端。
- 研究人员患者列表、报告、影像上传与 Findviz 页面可打开；复杂桌面页面允许横向滚动。
- DAC 页面能加载后端数据。
- 关闭并重开 App 后服务器地址和登录状态按预期保留。
- Android 返回键不会意外直接退出多页面流程。

## 第一阶段不包含

- 将 Python、MySQL、Qwen、HGST 或 Findviz 服务嵌入手机。
- 公网服务器部署、域名、HTTPS 证书和应用商店发布签名。
- 对每个研究端大屏进行完全原生化重做。
- 推送通知、相机、定位等新业务功能。
- 修改或回写学姐的原网站。

## 成功标准

在原站文件哈希保持不变的情况下生成 Debug APK，并在华为畅享 10 上完成三类角色的登录分流和至少一次真实后端健康检查。任何移动端适配都只存在于 `mobile-app/` 中。
