CREATE DATABASE IF NOT EXISTS `adhd_demo`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE `adhd_demo`;

-- 时间序列文件上传记录表（.1D/.csv）。其余业务表由 SQLAlchemy `Base.metadata.create_all`
-- 在启动时自动创建（backend/app/db/init_db.py）。此段仅在需要为 MySQL 手工预建该新增表时使用。
CREATE TABLE IF NOT EXISTS `uploads` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `patient_id` INT NULL,
  `uploader_id` INT NOT NULL,
  `file_name` VARCHAR(255) NOT NULL,
  `source_type` VARCHAR(32) NOT NULL DEFAULT 'fMRI_1D',
  `file_size` INT NOT NULL DEFAULT 0,
  `file_hash` VARCHAR(64) NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'uploaded',
  `stored_path` VARCHAR(1024) NOT NULL,
  `note` TEXT NULL,
  `created_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  KEY `ix_uploads_patient_id` (`patient_id`),
  KEY `ix_uploads_uploader_id` (`uploader_id`),
  CONSTRAINT `fk_uploads_patient_id_patients`
    FOREIGN KEY (`patient_id`) REFERENCES `patients` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_uploads_uploader_id_users`
    FOREIGN KEY (`uploader_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Existing deployments must add this nullable link once before restarting the API:
-- ALTER TABLE `model_predictions`
--   ADD COLUMN `upload_id` INT NULL,
--   ADD UNIQUE KEY `ix_model_predictions_upload_id` (`upload_id`),
--   ADD CONSTRAINT `fk_model_predictions_upload_id_uploads`
--     FOREIGN KEY (`upload_id`) REFERENCES `uploads` (`id`) ON DELETE SET NULL;
