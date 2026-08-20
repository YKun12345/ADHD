#DeepSeek-V4-Pro Beta 2026-05-05 00：00：00

import json
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

from sqlalchemy import create_engine, text
from app.core.config import settings

EXPORT_PATH = r"D:\竞赛\计算机设计大赛\202605010110——参赛作品总文件夹\05 AI工具使用说明\json日志"

def export_chat_logs():
    os.makedirs(EXPORT_PATH, exist_ok=True)
    
    engine = create_engine(settings.SQLALCHEMY_DATABASE_URI)
    
    try:
        with engine.connect() as conn:
            result = conn.execute(text("SELECT * FROM ai_chat_logs ORDER BY created_at ASC"))
            logs = result.fetchall()
            
            log_data = []
            for row in logs:
                created_at = row[5]
                if hasattr(created_at, 'isoformat'):
                    created_at = created_at.isoformat()
                log_dict = {
                    "id": row[0],
                    "patient_id": row[1],
                    "role": row[2],
                    "scope": row[3],
                    "content": row[4],
                    "created_at": str(created_at) if created_at else None
                }
                log_data.append(log_dict)
            
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"ai_chat_logs_{timestamp}.json"
            filepath = os.path.join(EXPORT_PATH, filename)
            
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(log_data, f, ensure_ascii=False, indent=2)
            
            print(f"✅ 成功导出 {len(log_data)} 条对话日志")
            print(f"📁 文件路径: {filepath}")
            
    except Exception as e:
        print(f"❌ 导出失败: {str(e)}")
        raise

if __name__ == "__main__":
    export_chat_logs()