# 微信小程序真机预览准备设计

日期：2026-08-21

## 目标与边界

D13 先完成 Codex 可独立完成的网络配置、旧内核兼容、静态审计和验收清单。扫码预览、iOS/Android 实体操作、局域网 IP、防火墙、合法域名后台配置仍必须由 A 最终执行，因此未取得双端证据前 D13 最高记 75%，不得写成 100%。

## 审计结论

1. `request.js` 固定 `http://127.0.0.1:8000/api/v1`，真机中的 127.0.0.1 指向手机自身。
2. 私有开发者配置关闭域名校验，但该配置不能替代正式小程序的 HTTPS 合法域名配置。
3. 生产代码使用 `.at(-1)` 和 `Object.hasOwn`，旧 Android 微信 JavaScript 内核存在兼容风险。
4. Canvas、输入法、长文滚动、复制链接、快速触摸节奏只能在实体设备最终确认。
5. `project.private.config.json` 是用户私有配置，不应修改或提交。

## 方案

新增纯逻辑 `api-config.js` 与 `pages/server-settings/index`：

- 默认仍为开发者工具地址 `http://127.0.0.1:8000/api/v1`；
- 支持 `https://域名[/api/v1]`；
- 开发联调支持 localhost、127.0.0.1 和私有 IPv4（10/8、172.16—31/12、192.168/16）的 HTTP 地址；
- 拒绝公网 HTTP、账号密码 URL、query、hash 和任意额外路径；
- 输入主机根地址时自动补 `/api/v1`，去除末尾斜杠；
- 测试 `/health` 返回 `{status:'ok'}` 后才保存；
- storage 只保存服务器基地址，不保存 token 或医疗数据；
- 设置页明确区分“本机开发”“局域网调试”“HTTPS 正式环境”。

`request.js` 每次请求时读取已验证配置，测试连接可传临时候选地址和 `skipAuth`。登录页与患者首页提供服务器设置入口。401 逻辑保持不变。

兼容性修复只做等价替换：

- `array.at(-1)` → `array[array.length - 1]`；
- `Object.hasOwn(object, key)` → `Object.prototype.hasOwnProperty.call(object, key)`。

不修改业务计算、不修改 B 文件、不修改 `project.private.config.json`。

## 自动验收

- URL 校验覆盖 HTTPS、三类私有 IPv4、localhost、端口、尾斜杠、非法协议、公网 HTTP、凭据、query/hash 和额外路径；
- 请求层覆盖默认地址、已保存地址、临时候选地址、skipAuth 和无效配置回退；
- 设置页覆盖输入、校验、健康检查成功保存、失败不保存、防重复、恢复默认和返回；
- 登录/首页入口及路由有结构和控制测试；
- 静态测试确认生产代码不再出现 `.at(` 或 `Object.hasOwn(`；
- 全量测试、JS、JSON、Git 边界全部通过。

## 人工验收清单

输出 `docs/2026-08-21-miniprogram-device-checklist.md`，按准备电脑后端、查局域网 IPv4、同 Wi‑Fi、设置地址、iOS/Android 逐模块检查、截图留证、恢复正式 HTTPS 的顺序编写。任何未执行项必须保持未勾选。
