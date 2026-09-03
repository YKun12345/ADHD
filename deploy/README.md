# ADHD 后端云端/公网部署（deploy/）

答辩演示的完整说明见 `.claude/公网部署方案-答辩演示.md`（该文件被 git 忽略，仅本机）。
本目录是可入库、可复用的部署文件。

## 文件清单

| 文件 | 作用 |
|---|---|
| `../Dockerfile` | 后端演示运行镜像（不含 torch/HGST 重型依赖，约几百 MB） |
| `../.dockerignore` | 构建上下文排除项 |
| `docker-compose.yml` | MySQL 8 + (Redis 可选) + API 编排；默认 `APP_ENV=development` 以便播种演示账号 |
| `deploy.sh` | Ubuntu VPS 一键部署（Docker + 可选 nginx + certbot HTTPS） |
| `nginx/backend.conf` | 宿主 nginx 反代到 `127.0.0.1:8000` |
| `.env.production.example` | 环境变量模板（复制为 `.env` 后编辑，勿提交 `.env`） |

## 快速开始（本地 Docker 也能先验证）

```bash
# 1) 准备 .env
cd deploy
cp .env.production.example .env        # 编辑口令

# 2) 构建并启动（MySQL + API）
docker compose -p adhd up -d --build

# 3) 验证
curl -fsS http://127.0.0.1:8000/api/v1/health
docker compose -p adhd logs api | tail -20    # 看种子演示账号
```

> 演示账号：`backend/scripts/seed_demo_data.py` 只在非 production 下运行并在日志打印账号。

## 云服务器（Ubuntu）

```bash
# 仓库先放上 VPS，例如：git clone <你的 ADHD 仓库> 到 /opt/adhd
cd /opt/adhd
bash deploy/deploy.sh                    # 先只部署
DOMAIN=api.example.com bash deploy/deploy.sh
```

- 安全组 / ufw 放行：`22`（SSH）、`80`/`443`（用 nginx 时）。
- 云盾/安全组若同时存在，两者都要放行。

## 重要边界

- 镜像**不含真实 HGST 推理**（torch/dhg/模型权重）。演示用 Mock 推理；真实推理接口在缺依赖/权重时返回可理解的错误。
- `APP_ENV=production` 会拒绝播种演示数据（`seed_demo_data` 主动退出）。答辩演示请保持默认的 `development`。
- 小程序「合法域名」要求 **HTTPS + 备案域名**；临时演示见主文档的「小程序真机接入」章节。
