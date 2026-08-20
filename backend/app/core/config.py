import os
from functools import cached_property
from pathlib import Path
from urllib.parse import quote_plus

from dotenv import load_dotenv


load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=True)


class Settings:
    PROJECT_NAME: str = os.getenv("PROJECT_NAME", "ADHD Assist Platform API")
    API_V1_STR: str = os.getenv("API_V1_STR", "/api/v1")
    SECRET_KEY: str = os.getenv("SECRET_KEY", "change-this-secret-before-production")
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "1440"))
    DATABASE_URL: str = os.getenv("DATABASE_URL", "").strip()

    MYSQL_HOST: str = os.getenv("MYSQL_HOST", "127.0.0.1")
    MYSQL_PORT: int = int(os.getenv("MYSQL_PORT", "3306"))
    MYSQL_USER: str = os.getenv("MYSQL_USER", "root")
    MYSQL_PASSWORD: str = os.getenv("MYSQL_PASSWORD", "123456")
    MYSQL_DB: str = os.getenv("MYSQL_DB", "adhd_demo")

    BACKEND_CORS_ORIGINS: str = os.getenv(
        "BACKEND_CORS_ORIGINS",
        "http://127.0.0.1:5500,http://localhost:5500",
    )
    QWEN_API_KEY: str = os.getenv("QWEN_API_KEY", "").strip()
    QWEN_BASE_URL: str = os.getenv(
        "QWEN_BASE_URL",
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    ).strip()
    QWEN_CHAT_MODEL: str = os.getenv("QWEN_CHAT_MODEL", "qwen-plus-latest").strip()
    QWEN_REMINDER_MODEL: str = os.getenv("QWEN_REMINDER_MODEL", "qwen-flash").strip()
    QWEN_TIMEOUT_SECONDS: int = int(os.getenv("QWEN_TIMEOUT_SECONDS", "120"))
    HGST_PRETRAINED_WEIGHTS_PATH: str = os.getenv(
        "HGST_PRETRAINED_WEIGHTS_PATH",
        str(
            (
                Path(__file__).resolve().parents[3]
                / "HGST-main"
                / "logs"
                / "ADHD"
                / "sparse_2026-04-01-11-41-03"
                / "pretrained_model_2020.pth"
            ).resolve()
        ),
    ).strip()
    HGST_DEPLOYMENT_BUNDLE_PATH: str = os.getenv(
        "HGST_DEPLOYMENT_BUNDLE_PATH",
        str((Path(__file__).resolve().parents[2] / "artifacts" / "hgst_adhd_bundle.pt").resolve()),
    ).strip()
    HGST_DEFAULT_DATA_DIR: str = os.getenv("HGST_DEFAULT_DATA_DIR", "").strip()
    HGST_DEFAULT_LABELS_PATH: str = os.getenv("HGST_DEFAULT_LABELS_PATH", "").strip()

    @cached_property
    def SQLALCHEMY_DATABASE_URI(self) -> str:
        if self.DATABASE_URL:
            return self.DATABASE_URL

        password = quote_plus(self.MYSQL_PASSWORD)
        return (
            f"mysql+pymysql://{self.MYSQL_USER}:{password}"
            f"@{self.MYSQL_HOST}:{self.MYSQL_PORT}/{self.MYSQL_DB}"
            "?charset=utf8mb4"
        )

    @cached_property
    def is_sqlite(self) -> bool:
        return self.SQLALCHEMY_DATABASE_URI.startswith("sqlite")

    @cached_property
    def cors_origins(self) -> list[str]:
        return [
            origin.strip()
            for origin in self.BACKEND_CORS_ORIGINS.split(",")
            if origin.strip()
        ]


settings = Settings()
