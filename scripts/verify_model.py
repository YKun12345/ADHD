#!/usr/bin/env python
"""仓库根薄壳：`python scripts/verify_model.py` 直达后端模型校验脚本。

真正的逻辑在 ``backend/scripts/verify_model.py``；本文件只把仓库根加入
``sys.path`` 后调用它，便于按用户要求的命令一键校验模型集成链路。
也可直接运行：``python -m backend.scripts.verify_model``
"""

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from backend.scripts.verify_model import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
