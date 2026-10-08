-- Optional reviewed rollout for an existing SQLite database.
-- Back up first. These statements are for a schema that lacks test_run_id.
-- Future application startup also performs this upgrade idempotently.
-- Do not backfill legacy records: NULL keeps their original identity intact.

ALTER TABLE cognitive_tests ADD COLUMN test_run_id VARCHAR(64);

CREATE UNIQUE INDEX uq_cognitive_tests_patient_type_run
  ON cognitive_tests (patient_id, test_type, test_run_id);
