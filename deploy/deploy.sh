#!/usr/bin/env bash
# ============================================================================
# ADHD 后端云端部署脚本（Ubuntu 22.04/24.04 + Docker + 可选 nginx/certbot）
# 用法：在【仓库根目录】执行：
#   bash deploy/deploy.sh                # 仅部署 API(MySQL)
#   DOMAIN=api.example.com bash deploy/deploy.sh          # 额外配置 nginx 反代
#   DOMAIN=api.example.com EMAIL=you@x.com bash deploy/deploy.sh  # 再加 HTTPS
#
# 前置：云服务器已放行端口（安全组 + ufw）：22/80/443（若用 nginx）。
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"

echo "==> 仓库目录：$REPO_DIR"
cd "$REPO_DIR"

# ---------- 1. Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  echo "==> 未检测到 Docker，开始安装..."
  curl -fsSL https://get.docker.com | sh
  sudo systemctl enable --now docker
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "错误：缺少 Docker Compose v2 插件（docker compose）。请先安装。"
  exit 1
fi
echo "==> Docker: $(docker --version) | Compose: $(docker compose version --short)"

# ---------- 2. 环境变量 ----------
cd "$REPO_DIR/deploy"
if [ ! -f .env ]; then
  cp .env.production.example .env
  echo ""
  echo "已生成 deploy/.env —— 请先编辑其中的 MYSQL 口令与 SECRET_KEY，再重新执行本脚本。"
  exit 0
fi
echo "==> 使用 deploy/.env"

# ---------- 3. 构建并启动 ----------
echo "==> docker compose up -d --build"
docker compose -p adhd up -d --build

# ---------- 4. 健康检查 ----------
echo "==> 等待 API 健康..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:8000/api/v1/health" >/dev/null 2>&1; then
    echo "✅ API 健康：http://127.0.0.1:8000/api/v1/health"
    break
  fi
  [ "$i" = 30 ] && { echo "❌ 30 秒内 API 未就绪，查看日志：docker compose -p adhd logs api"; exit 1; }
  sleep 2
done

echo "==> 演示账号（如有，见容器日志，一般形如 admin/patient 演示账号）："
docker compose -p adhd logs api 2>/dev/null | grep -iE "演示|demo|账号|account" | tail -n 5 || true

# ---------- 5. nginx 反代（可选） ----------
if [ -n "$DOMAIN" ]; then
  echo "==> 配置 nginx 反向代理：$DOMAIN -> 127.0.0.1:8000"
  if ! command -v nginx >/dev/null 2>&1; then
    sudo apt-get update -y && sudo apt-get install -y nginx
  fi
  sudo cp "$REPO_DIR/deploy/nginx/backend.conf" /etc/nginx/sites-available/adhd
  sudo sed -i "s/^    server_name .*;/    server_name ${DOMAIN};/" /etc/nginx/sites-available/adhd
  sudo ln -sf /etc/nginx/sites-available/adhd /etc/nginx/sites-enabled/adhd
  sudo nginx -t && sudo systemctl reload nginx
  echo "✅ nginx 已加载 http://${DOMAIN}/doctor-web/"

  if [ -n "$EMAIL" ]; then
    echo "==> 申请 HTTPS（小程序强制要求 HTTPS）..."
    if ! command -v certbot >/dev/null 2>&1; then
      sudo apt-get install -y certbot python3-certbot-nginx
    fi
    sudo certbot --nginx -d "$DOMAIN" --email "$EMAIL" --agree-tos --redirect || true
    echo "✅ HTTPS 就绪 https://${DOMAIN}/doctor-web/"
  fi
fi

echo ""
echo "全部完成。验证命令："
echo "  curl -fsS http://127.0.0.1:8000/api/v1/health"
[ -n "$DOMAIN" ] && echo "  浏览器打开 https://${DOMAIN}/doctor-web/ （或 http://${DOMAIN}/doctor-web/）"
