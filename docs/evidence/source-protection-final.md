# A/B 原目录最终保护复核

- 复核日期：2026-08-30（Asia/Shanghai）
- 方法：使用 `tools/merge/source_inventory.ps1` 对 A、B 原目录重新执行只读清单，按相对路径、文件大小和 SHA-256 与导入前清单逐项比较；同时比较 Git HEAD 和完整工作区状态。

## A 原目录

- Git HEAD：`f175d53ddd862b695cc7fb1e02902c45b012a3e1` → 相同
- 文件数：543 → 543
- 内容摘要：`8fbee27140bc137ed006d34eaae3c4179feba8940055fde0ca9516f373a30ec7` → 相同
- 初始/最终 Git 状态项：149 → 149
- 文件差异：0
- Git 状态差异：0

## B 原目录

- Git HEAD：`2e0075d1d8b9b32e2f3a4cf444244ec42c91991c` → 相同
- 文件数：476 → 476
- 内容摘要：`764c6c828f072f282ba066c3eb211ecd091174507f3747a9e92d6d6cbdc9c072` → 相同
- 初始/最终 Git 状态项：185 → 185
- 文件差异：0
- Git 状态差异：0

结论：本次 AB 合并过程没有改变 A、B 原目录的受盘点文件内容、Git HEAD 或工作区状态。原始完整清单见 `docs/evidence/source-a.json` 与 `docs/evidence/source-b.json`。
