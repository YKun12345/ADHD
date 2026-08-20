# Backend Setup

## 1. Install dependencies

```bash
pip install -r requirements.txt
```

## 2. Choose a database mode

### Option A: Temporary SQLite mode

If you want to develop immediately without installing MySQL, set this in `backend/.env`:

```env
DATABASE_URL=sqlite:///./backend/app.db
```

In this mode, you can skip MySQL installation and skip the SQL script below.

### Option B: MySQL mode

Leave `DATABASE_URL` empty, then create the MySQL database.

## 3. Create the MySQL database

Run the SQL in [init_mysql.sql](/d:/ADHD_Web/ADHD_Web/backend/sql/init_mysql.sql), or execute:

```sql
CREATE DATABASE IF NOT EXISTS `adhd_demo`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;
```

## 4. Configure environment

Copy [`.env.example`](/d:/ADHD_Web/ADHD_Web/backend/.env.example) to `backend/.env`.

- For SQLite: set `DATABASE_URL=sqlite:///./backend/app.db`
- For MySQL: keep `DATABASE_URL=` empty, then edit the MySQL account and secret key
- To enable the Qwen assistant: fill in `QWEN_API_KEY`

## 5. Create tables

From the repo root:

```bash
python -m backend.create_tables
```

## 6. Run the API

From the repo root:

```bash
uvicorn backend.app.main:app --reload
```

After the server starts, open the frontend through HTTP, for example:

```text
http://127.0.0.1:8000/doctor_visualization.html
```

Do not double-click `doctor_visualization.html` or open it as `file://...`, otherwise browser security rules will block the visualization module, local template fetches, and GIfTI/NIfTI viewer startup.

## 7. One-line switch rule

- Use SQLite now:

```env
DATABASE_URL=sqlite:///./backend/app.db
```

- Switch back to MySQL later:

```env
DATABASE_URL=
```

Then keep the `MYSQL_*` values filled in.

## 8. API endpoints included now

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/me`
- `GET /api/v1/health`
- `GET /api/v1/ai/status`
- `POST /api/v1/ai/chat`
- `POST /api/v1/ai/explain_report`
- `POST /api/v1/ai/generate_reminder`

## 8.1 Qwen assistant setup

Add these variables to `backend/.env` if you want the patient-side AI assistant to use Qwen:

```env
QWEN_API_KEY=your-dashscope-api-key
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
QWEN_CHAT_MODEL=qwen-plus-latest
QWEN_REMINDER_MODEL=qwen-flash
QWEN_TIMEOUT_SECONDS=60
```

If `QWEN_API_KEY` is empty, the backend will automatically fall back to template-based report interpretation and reminder text so the frontend still works.

## 9. Register payload example

```json
{
  "email": "patient@example.com",
  "password": "BrainMap#2026Safe",
  "full_name": "Test Patient",
  "role": "patient",
  "consent_agreed": true,
  "patient_profile": {
    "age": 20,
    "gender": "female",
    "patient_type": "adult"
  }
}
```

## 10. Login payload example

```json
{
  "email": "patient@example.com",
  "password": "BrainMap#2026Safe",
  "role": "patient"
}
```
