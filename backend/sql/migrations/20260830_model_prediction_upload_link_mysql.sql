-- AB merge upgrade: connect one real model prediction to one persisted upload.
-- MySQL 8.x. Back up the database before running schema migrations.

DELIMITER //
CREATE PROCEDURE migrate_model_prediction_upload_link()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'model_predictions'
          AND COLUMN_NAME = 'upload_id'
    ) THEN
        ALTER TABLE model_predictions ADD COLUMN upload_id INTEGER NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'model_predictions'
          AND INDEX_NAME = 'ux_model_predictions_upload_id'
    ) THEN
        ALTER TABLE model_predictions
            ADD UNIQUE INDEX ux_model_predictions_upload_id (upload_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND TABLE_NAME = 'model_predictions'
          AND CONSTRAINT_NAME = 'fk_model_predictions_upload_id_uploads'
    ) THEN
        ALTER TABLE model_predictions
            ADD CONSTRAINT fk_model_predictions_upload_id_uploads
            FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE SET NULL;
    END IF;
END//
DELIMITER ;

CALL migrate_model_prediction_upload_link();
DROP PROCEDURE migrate_model_prediction_upload_link;
