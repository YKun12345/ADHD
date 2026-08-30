# AB 合并版来源清单

生成日期：2026-08-30

## 来源 A

- 原目录：`C:\Users\Lenovo\Desktop\源码`
- Git 基线：`f175d53ddd862b695cc7fb1e02902c45b012a3e1`
- 读取时工作区状态项：149
- 纳入内容指纹的文件：543
- 内容指纹：`8fbee27140bc137ed006d34eaae3c4179feba8940055fde0ca9516f373a30ec7`
- 详细清单：`docs/evidence/source-a.json`
- 本次用途：Git 历史基座；当前 `miniprogram/` 是合并版小程序的事实源。

A 原目录中未提交的小程序成果没有被丢弃或归入 B：它们在隔离仓库中形成独立的 `snapshot(A)` 提交。原目录保持只读。

## 来源 B

- 原目录：`D:\xwechat_files\wxid_3toll5v8nbqt22_16a1\msg\file\2026-08\源码(3)\源码`
- Git 基线：`2e0075d1d8b9b32e2f3a4cf444244ec42c91991c`
- 读取时工作区状态项：185
- 纳入内容指纹的文件：476
- 内容指纹：`764c6c828f072f282ba066c3eb211ecd091174507f3747a9e92d6d6cbdc9c072`
- 详细清单：`docs/evidence/source-b.json`
- 本次用途：后端、模型/可视化、医生端 Web 和相关运行文档的事实源。

B 的小程序不会覆盖 A 的小程序。B 的成果在隔离仓库中形成独立的 `import(B)` 提交。原目录保持只读。

## 固定排除规则

以下内容不会从任一来源进入交付版：

- `.git` 之外的源仓库内部元数据目录和个人代理配置
- `.venv/`、`venv/`、`node_modules/`
- `__pycache__/`、`.pytest_cache/`、`*.pyc`、`*.pyo`
- `logs/`、`tmp/`、`downloads/`
- `backend/app.db`、`backend/.env`、`backend/uploads/`
- `backend/artifacts/` 及 `*.pt`、`*.pth`、`*.ckpt` 模型权重
- 微信开发者工具个人配置 `project.private.config.json`
- `.codex-tmp/`、`.worktrees/`、`.superpowers/`、`.claude/`

项目需要的依赖清单、环境示例、数据库初始化脚本和模型构建脚本仍会保留。

## 清单语义

JSON 清单中的 `content_digest` 只由排序后的相对路径、文件大小和 SHA-256 组成，不包含生成时间，因此可用于最终只读复核。`git_status` 用于记录导入时两个来源的脏工作区事实，不表示这些状态由合并过程造成。
