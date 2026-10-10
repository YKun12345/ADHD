# 知行合医部署文件

本目录提供可复用的 Docker 演示部署。后端镜像使用 Python 3.11，包含网页入口和轻量业务依赖；真实 HGST 推理需另行准备已验证的依赖、权重与镜像。

| 文件 | 作用 |
|---|---|
| `../Dockerfile` | 明确启用 Mock 的演示镜像 |
| `../.dockerignore` | 排除本地构建、预览、备份、密钥、日志及真实上传文件 |
| `docker-compose.yml` | MySQL 8、API、可选 Redis；Redis 当前未参与业务 |
| `deploy.sh` | Ubuntu 部署，按需启用 nginx 与 HTTPS |
| `nginx/backend.conf` | 默认代理 8000；脚本按实际 API_PORT 修改 |
| `.env.production.example` | Docker 环境模板，默认 development 演示模式 |

## Docker 演示

在仓库根目录执行：

```bash
cd deploy
cp .env.production.example .env
# 编辑 .env：替换 SECRET_KEY、MYSQL_ROOT_PASSWORD 与 MYSQL_PASSWORD
# 演示保持 APP_ENV=development、USE_MOCK_MODEL=true
# DEEPSEEK_API_KEY 可留空，使用明确标识的模板回答

docker compose -p adhd up -d --build
curl -fsS http://127.0.0.1:8000/api/v1/health
```

若修改 `API_PORT`，手工检查也应使用该端口；`deploy.sh` 从实际端口映射读取端口，健康检查与 nginx 使用同一值。容器内部端口仍为 8000。

非生产环境会显式执行 `seed_demo_data`；生产跳过播种。演示账号仅用于测试，不得用于真实患者资料。不会创建公开固定的 DAC 管理账号。

AI 配置统一使用 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_CHAT_MODEL`、`DEEPSEEK_REMINDER_MODEL` 和 `DEEPSEEK_TIMEOUT_SECONDS`。“已配置”只表示配置存在；实际调用结果才说明请求是否成功。

## 密钥、迁移与持久化

`DATA_ENCRYPTION_KEY` 是 base64url 编码的 32 字节随机 AES-GCM 密钥。开发环境未设置时，后端在 `backend/.keys/data_encryption.key` 生成密钥；`SECURITY_MASTER_KEY_PATH` 可指定独立文件位置。

Docker 默认把密钥文件保存在 `api_keys` 独立卷内，路径为 `/app/backend/.keys/data_encryption.key`；业务上传文件在 `api_uploads`，数据库在 `mysql_data`，加密迁移备份在 `api_migration_backups`。重建容器会复用这些卷。删除卷或遗失主密钥可能导致加密数据无法读取，必须分别备份数据库、上传文件和密钥；不要把真实密钥写进镜像或交付包。

生产必须提供有效的 `DATA_ENCRYPTION_KEY`，或在 `SECURITY_MASTER_KEY_PATH` 放置已存在的有效密钥文件；生产不会自动生成密钥。若使用容器自定义路径，须另外挂载该密钥文件。

数据库初始化会幂等调用敏感数据迁移。迁移前，SQLite 副本与上传文件原件均使用 AES-GCM 加密后保存在 `backend/migration-backups/<timestamp>/`，备份文件带 `.enc` 后缀。该目录仍需限制访问并按保留规则处理；MySQL 应由运维先完成独立备份。备份恢复也依赖原主密钥，不要在资料仍依赖旧密钥时直接更换它。

影像可视化上传使用独立的 `FINDVIZ_MAX_UPLOAD_BYTES`，默认请求总上限512 MiB（含表单开销）；数值时间序列预测上传仍使用 `UPLOAD_MAX_BYTES`，默认10 MiB。影像入口在 ASGI 读入前和读入过程中限制请求大小，Flask 再检查上限，multipart 文件仅在内存解析，避免大文件原文落入临时磁盘。

## Ubuntu 服务器

先准备 `deploy/.env`，再从仓库根目录运行：

```bash
bash deploy/deploy.sh
DOMAIN=api.example.com bash deploy/deploy.sh
DOMAIN=api.example.com EMAIL=ops@example.com bash deploy/deploy.sh
```

使用 nginx 时，域名须解析到服务器，并放行 80/443；API 默认仅绑定宿主回环地址。Compose 显式启用代理头并传递 `FORWARDED_ALLOW_IPS`，使 HTTPS 经 Docker 网关转发后仍能正确识别协议、执行影像来源校验。默认 `*` 适用于本配置的宿主回环映射和可信服务网络；切换公网直连或加入不可信容器时，应改为实际可信代理 IP 列表。证书申请失败会退出并说明失败，不会显示 HTTPS 成功。

## 生产验收

`APP_ENV=production` 需要至少 32 字符的非占位 `SECRET_KEY`、明确的数据库 URL、非占位数据库口令及有效加密密钥。默认演示配置不能直接作为生产配置。

真实 HGST 推理须补齐依赖、有效权重和数据标签，并设置 `USE_MOCK_MODEL=false`。缺依赖或权重时返回错误，不会默默当作真实结果。Mock 输出始终属于演示数据。

上线前仍需验收 HTTPS、角色与患者范围、数据迁移、备份恢复、真实模型及小程序域名配置。本机未执行 Docker 实机部署或公网证书签发；自动回归只验证配置传递和隔离的脚本行为。
