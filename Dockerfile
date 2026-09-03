# ADHD FastAPI backend — 演示运行镜像（不含 PyTorch/HGST 重型依赖）
#
# 设计说明：
#   - 答辩演示用 Mock 推理 + SQLite/MySQL 演示数据即可，真实 HGST fMRI 推理需要
#     Python<=3.10 + torch1.13 + dhg + 模型权重，不适合塞进本演示镜像。
#   - 应用启动不依赖 torch：modeling.py(torch/dhg) 在服务内延迟 import；
#     pandas/scikit-learn/scipy 由 nilearn 自动带入 requirements.txt 安装。
#   - 真实推理接口在权重/依赖缺失时会返回可理解的错误，不会静默降级成 Mock。
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Asia/Shanghai

WORKDIR /app

# curl 用于 compose healthcheck；tzdata 用于设置时区
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY . .

EXPOSE 8000

# 默认只起 uvicorn（配合 SQLite 单机快速演示可直接用）。
# docker-compose 会覆盖本命令：加 create_tables + seed_demo_data（见 deploy/docker-compose.yml）。
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
