-- AB 合并版 MySQL 引导脚本。
-- 本脚本只创建空数据库，避免在 users/patients 等父表尚不存在时
-- 提前创建带外键的 uploads 表而导致初始化失败。

CREATE DATABASE IF NOT EXISTS `adhd_demo`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE `adhd_demo`;

-- 配置 backend/.env 的 DATABASE_URL 后，从仓库根目录执行：
-- python -m backend.create_tables
--
-- SQLAlchemy 会按元数据依赖顺序创建 users、patients、uploads、
-- model_predictions 及其他当前业务表。
--
-- 注意：create_all 不会升级已经存在的旧表。旧 MySQL 实例若缺少
-- uploads 或 model_predictions.upload_id，必须先备份，再由数据库管理员
-- 按 backend/app/models/ 中的当前模型编写并审核迁移；不要在生产库盲目执行
-- 来历不明的 ALTER TABLE。
