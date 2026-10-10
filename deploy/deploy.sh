#!/usr/bin/env bash
# ADHD 演示后端部署：Ubuntu + Docker，按需配置 nginx/certbot。
# 从仓库根目录运行 bash deploy/deploy.sh；DOMAIN/EMAIL 仅用于显式启用反代/HTTPS。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"

if [ -n "$DOMAIN" ] && [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "错误：DOMAIN 必须是有效的域名。" >&2
  exit 1
fi

cd "$REPO_DIR"
if ! command -v docker >/dev/null 2>&1; then
  echo "==> 未检测到 Docker，开始安装..."
  curl -fsSL https://get.docker.com | sh
  sudo systemctl enable --now docker
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "错误：缺少 Docker Compose v2 插件。请先安装。" >&2
  exit 1
fi

cd "$REPO_DIR/deploy"
if [ ! -f .env ]; then
  cp .env.production.example .env
  echo "已生成 deploy/.env。请编辑口令、运行模式和加密配置后重新执行。"
  exit 0
fi

echo "==> 使用 deploy/.env 构建并启动"
docker compose -p adhd up -d --build

# 从实际端口映射读取 API_PORT，避免执行包含口令的 .env 文件。
API_BINDING="$(docker compose -p adhd port api 8000)"
API_PORT="${API_BINDING##*:}"
if [[ ! "$API_PORT" =~ ^[0-9]+$ ]] || (( API_PORT < 1 || API_PORT > 65535 )); then
  echo "错误：无法读取 API 对外端口。" >&2
  exit 1
fi
HEALTH_URL="http://127.0.0.1:${API_PORT}/api/v1/health"
echo "==> 等待 API 健康..."
for i in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "✅ API 健康：$HEALTH_URL"
    break
  fi
  if [ "$i" = 30 ]; then
    echo "❌ API 约 60 秒内未就绪。查看日志：docker compose -p adhd logs api" >&2
    exit 1
  fi
  sleep 2
done

PUBLIC_URL=""
if [ -n "$DOMAIN" ]; then
  echo "==> 配置 nginx：$DOMAIN -> 127.0.0.1:$API_PORT"
  if ! command -v nginx >/dev/null 2>&1; then
    sudo apt-get update -y
    sudo apt-get install -y nginx
  fi
  sudo cp "$REPO_DIR/deploy/nginx/backend.conf" /etc/nginx/sites-available/adhd
  sudo sed -i "s/^    server_name .*;/    server_name ${DOMAIN};/" /etc/nginx/sites-available/adhd
  sudo sed -i "s|http://127.0.0.1:8000|http://127.0.0.1:${API_PORT}|" /etc/nginx/sites-available/adhd
  sudo ln -sf /etc/nginx/sites-available/adhd /etc/nginx/sites-enabled/adhd
  sudo nginx -t
  sudo systemctl reload nginx
  PUBLIC_URL="http://${DOMAIN}/doctor-web/"
  echo "✅ nginx 已加载 $PUBLIC_URL"

  if [ -n "$EMAIL" ]; then
    if ! command -v certbot >/dev/null 2>&1; then
      sudo apt-get install -y certbot python3-certbot-nginx
    fi
    if sudo certbot --nginx -d "$DOMAIN" --email "$EMAIL" --agree-tos --redirect; then
      PUBLIC_URL="https://${DOMAIN}/doctor-web/"
      echo "✅ HTTPS 就绪 $PUBLIC_URL"
    else
      echo "❌ HTTPS 证书申请失败；检查域名解析、80/443 端口和 certbot 日志后重试。" >&2
      exit 1
    fi
  fi
fi

echo "部署完成。验证命令：curl -fsS $HEALTH_URL"
if [ -n "$PUBLIC_URL" ]; then
  echo "浏览器打开 $PUBLIC_URL"
fi
