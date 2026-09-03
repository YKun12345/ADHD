#!/usr/bin/env python
"""仓库根薄壳：`python scripts/migrate_sqlite_to_mysql.py` 直达后端迁移脚本。

真正的逻辑在 ``backend/scripts/migrate_sqlite_to_mysql.py``，
本文件只负责把仓库根加入 ``sys.path`` 后调用它，便于按用户要求的命令一键执行。
也可直接运行：``python -m backend.scripts.migrate_sqlite_to_mysql``
"""

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from backend.scripts.migrate_sqlite_to_mysql import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
