-- ADHD 后端 MySQL 目标表结构（由 SQLAlchemy 模型自动生成，勿手改；模型变更后请重新导出）。

-- 生成命令：python -m backend.scripts.migrate_sqlite_to_mysql --dump-schema

-- 依赖：先建库（utf8mb4 / utf8mb4_unicode_ci），InnoDB 与默认字符集取自 MySQL 8 库默认；

--       如需独立指定，可对生成的每个 CREATE TABLE 追加 ENGINE=InnoDB DEFAULT CHARSET=utf8mb4。



SET NAMES utf8mb4;

SET FOREIGN_KEY_CHECKS=0;


CREATE TABLE security_mcs_nodes (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	node_code VARCHAR(64) NOT NULL, 
	node_name VARCHAR(100) NOT NULL, 
	storage_backend VARCHAR(32) NOT NULL, 
	storage_namespace VARCHAR(100) NOT NULL, 
	is_active BOOL NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ix_security_mcs_nodes_node_code ON security_mcs_nodes (node_code);


CREATE TABLE users (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	email VARCHAR(255) NOT NULL, 
	staff_id VARCHAR(64), 
	full_name VARCHAR(100) NOT NULL, 
	password_hash VARCHAR(255) NOT NULL, 
	`role` VARCHAR(10) NOT NULL, 
	subrole VARCHAR(6), 
	consent_agreed BOOL NOT NULL, 
	is_active BOOL NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_users_staff_id ON users (staff_id);

CREATE UNIQUE INDEX ix_users_email ON users (email);

CREATE INDEX ix_users_role ON users (`role`);

CREATE INDEX ix_users_subrole ON users (subrole);


CREATE TABLE patients (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	user_id INTEGER NOT NULL, 
	assigned_researcher_id INTEGER, 
	age INTEGER, 
	gender VARCHAR(32), 
	patient_type VARCHAR(5) NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(assigned_researcher_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX ix_patients_assigned_researcher_id ON patients (assigned_researcher_id);

CREATE UNIQUE INDEX ix_patients_user_id ON patients (user_id);

CREATE INDEX ix_patients_patient_type ON patients (patient_type);


CREATE TABLE security_system_configs (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	is_initialized BOOL NOT NULL, 
	initialized_by_user_id INTEGER, 
	system_version VARCHAR(32) NOT NULL, 
	storage_mode VARCHAR(32) NOT NULL, 
	public_params_json JSON NOT NULL, 
	secret_params_json JSON NOT NULL, 
	profile_params_json JSON NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(initialized_by_user_id) REFERENCES users (id) ON DELETE SET NULL
);


CREATE TABLE ai_chat_logs (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	patient_id INTEGER NOT NULL, 
	session_id VARCHAR(100), 
	`role` VARCHAR(32) NOT NULL, 
	scope VARCHAR(32) NOT NULL, 
	content TEXT NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id) ON DELETE CASCADE
);

CREATE INDEX ix_ai_chat_logs_session_id ON ai_chat_logs (session_id);

CREATE INDEX ix_ai_chat_logs_patient_id ON ai_chat_logs (patient_id);


CREATE TABLE cognitive_tests (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	patient_id INTEGER NOT NULL, 
	test_type VARCHAR(64) NOT NULL, 
	result_json JSON NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id) ON DELETE CASCADE
);

CREATE INDEX ix_cognitive_tests_patient_id ON cognitive_tests (patient_id);


CREATE TABLE imaging_visualizations (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	patient_id INTEGER NOT NULL, 
	researcher_id INTEGER NOT NULL, 
	visualization_type VARCHAR(32) NOT NULL, 
	func_file_name VARCHAR(255), 
	anat_file_name VARCHAR(255), 
	mask_file_name VARCHAR(255), 
	left_func_file_name VARCHAR(255), 
	left_mesh_file_name VARCHAR(255), 
	right_func_file_name VARCHAR(255), 
	right_mesh_file_name VARCHAR(255), 
	slice_screenshot_name VARCHAR(255), 
	slice_screenshot_data LONGTEXT, 
	surface_screenshot_name VARCHAR(255), 
	surface_screenshot_data LONGTEXT, 
	slice_interpretation TEXT, 
	surface_interpretation TEXT, 
	summary_text TEXT NOT NULL, 
	notes TEXT, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id) ON DELETE CASCADE, 
	FOREIGN KEY(researcher_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX ix_imaging_visualizations_researcher_id ON imaging_visualizations (researcher_id);

CREATE INDEX ix_imaging_visualizations_patient_id ON imaging_visualizations (patient_id);


CREATE TABLE patient_tasks (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	patient_id INTEGER NOT NULL, 
	researcher_id INTEGER NOT NULL, 
	task_type VARCHAR(13) NOT NULL, 
	status VARCHAR(9) NOT NULL, 
	priority INTEGER NOT NULL, 
	task_title VARCHAR(120) NOT NULL, 
	task_description TEXT, 
	target_page VARCHAR(120), 
	target_payload_json TEXT, 
	due_at DATETIME, 
	created_at DATETIME NOT NULL, 
	completed_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id) ON DELETE CASCADE, 
	FOREIGN KEY(researcher_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX ix_patient_tasks_status ON patient_tasks (status);

CREATE INDEX ix_patient_tasks_task_type ON patient_tasks (task_type);

CREATE INDEX ix_patient_tasks_researcher_id ON patient_tasks (researcher_id);

CREATE INDEX ix_patient_tasks_patient_id ON patient_tasks (patient_id);


CREATE TABLE scale_results (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	patient_id INTEGER NOT NULL, 
	scale_type VARCHAR(64) NOT NULL, 
	score_json JSON NOT NULL, 
	total_score FLOAT NOT NULL, 
	risk_level VARCHAR(32) NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id) ON DELETE CASCADE
);

CREATE INDEX ix_scale_results_patient_id ON scale_results (patient_id);


CREATE TABLE security_patient_assignments (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	patient_id INTEGER NOT NULL, 
	patient_user_id INTEGER NOT NULL, 
	assigned_dac_user_id INTEGER, 
	assigned_mcs_node_id INTEGER, 
	assignment_status VARCHAR(32) NOT NULL, 
	assignment_version INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id) ON DELETE CASCADE, 
	FOREIGN KEY(patient_user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(assigned_dac_user_id) REFERENCES users (id) ON DELETE SET NULL, 
	FOREIGN KEY(assigned_mcs_node_id) REFERENCES security_mcs_nodes (id) ON DELETE SET NULL
);

CREATE INDEX ix_security_patient_assignments_patient_user_id ON security_patient_assignments (patient_user_id);

CREATE INDEX ix_security_patient_assignments_assigned_dac_user_id ON security_patient_assignments (assigned_dac_user_id);

CREATE UNIQUE INDEX ix_security_patient_assignments_patient_id ON security_patient_assignments (patient_id);

CREATE INDEX ix_security_patient_assignments_assigned_mcs_node_id ON security_patient_assignments (assigned_mcs_node_id);


CREATE TABLE security_user_keys (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	user_id INTEGER NOT NULL, 
	patient_id INTEGER, 
	key_role VARCHAR(32) NOT NULL, 
	key_version INTEGER NOT NULL, 
	public_key_json JSON NOT NULL, 
	private_key_json JSON NOT NULL, 
	key_fingerprint VARCHAR(128) NOT NULL, 
	is_active BOOL NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(patient_id) REFERENCES patients (id) ON DELETE CASCADE
);

CREATE INDEX ix_security_user_keys_user_id ON security_user_keys (user_id);

CREATE INDEX ix_security_user_keys_key_fingerprint ON security_user_keys (key_fingerprint);

CREATE INDEX ix_security_user_keys_patient_id ON security_user_keys (patient_id);


CREATE TABLE tracking_logs (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	patient_id INTEGER NOT NULL, 
	day_index INTEGER NOT NULL, 
	mood_tag VARCHAR(32), 
	focus_minutes INTEGER, 
	note TEXT, 
	test_score FLOAT, 
	activities VARCHAR(500), 
	is_medication BOOL, 
	medication_dosage VARCHAR(200), 
	attention_rating INTEGER, 
	hyperactivity_rating INTEGER, 
	impulsivity_rating INTEGER, 
	emotion_rating INTEGER, 
	task_completion_rating INTEGER, 
	sleep_quality VARCHAR(32), 
	appetite_quality VARCHAR(32), 
	has_conflict BOOL, 
	was_criticized BOOL, 
	side_effects VARCHAR(200), 
	special_events TEXT, 
	highlights TEXT, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_tracking_logs_patient_day UNIQUE (patient_id, day_index), 
	FOREIGN KEY(patient_id) REFERENCES patients (id) ON DELETE CASCADE
);

CREATE INDEX ix_tracking_logs_patient_id ON tracking_logs (patient_id);


CREATE TABLE uploads (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	patient_id INTEGER, 
	uploader_id INTEGER NOT NULL, 
	file_name VARCHAR(255) NOT NULL, 
	source_type VARCHAR(32) NOT NULL, 
	file_size INTEGER NOT NULL, 
	file_hash VARCHAR(64), 
	status VARCHAR(32) NOT NULL, 
	stored_path VARCHAR(1024) NOT NULL, 
	note TEXT, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id) ON DELETE CASCADE, 
	FOREIGN KEY(uploader_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX ix_uploads_patient_id ON uploads (patient_id);

CREATE INDEX ix_uploads_uploader_id ON uploads (uploader_id);


CREATE TABLE care_messages (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	patient_id INTEGER NOT NULL, 
	sender_user_id INTEGER NOT NULL, 
	sender_role VARCHAR(32) NOT NULL, 
	message_type VARCHAR(6) NOT NULL, 
	content TEXT NOT NULL, 
	client_message_id VARCHAR(64), 
	related_task_id INTEGER, 
	created_at DATETIME NOT NULL, 
	read_by_patient_at DATETIME, 
	read_by_researcher_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_care_messages_sender_client_message UNIQUE (sender_user_id, client_message_id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id) ON DELETE CASCADE, 
	FOREIGN KEY(sender_user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(related_task_id) REFERENCES patient_tasks (id) ON DELETE SET NULL
);

CREATE INDEX ix_care_messages_sender_user_id ON care_messages (sender_user_id);

CREATE INDEX ix_care_messages_patient_id ON care_messages (patient_id);


CREATE TABLE model_predictions (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	patient_id INTEGER NOT NULL, 
	upload_id INTEGER, 
	file_name VARCHAR(255) NOT NULL, 
	prediction_label VARCHAR(32) NOT NULL, 
	probability FLOAT NOT NULL, 
	probability_control FLOAT, 
	source_type VARCHAR(32) NOT NULL, 
	roi_dim_used INTEGER, 
	timepoints INTEGER, 
	model_name VARCHAR(64), 
	model_version VARCHAR(64), 
	summary_text TEXT, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id) ON DELETE CASCADE, 
	FOREIGN KEY(upload_id) REFERENCES uploads (id) ON DELETE SET NULL
);

CREATE INDEX ix_model_predictions_patient_id ON model_predictions (patient_id);

CREATE UNIQUE INDEX ix_model_predictions_upload_id ON model_predictions (upload_id);


CREATE TABLE security_audit_tasks (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	patient_id INTEGER NOT NULL, 
	requested_by_user_id INTEGER, 
	patient_assignment_id INTEGER, 
	mcs_node_id INTEGER, 
	task_type VARCHAR(32) NOT NULL, 
	source_type VARCHAR(32) NOT NULL, 
	status VARCHAR(32) NOT NULL, 
	included_record_ids_json JSON NOT NULL, 
	aggregate_ciphertext TEXT, 
	aggregate_digest VARCHAR(128), 
	verification_passed BOOL, 
	verification_details_json JSON NOT NULL, 
	decrypted_stats_json JSON NOT NULL, 
	created_at DATETIME NOT NULL, 
	completed_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id) ON DELETE CASCADE, 
	FOREIGN KEY(requested_by_user_id) REFERENCES users (id) ON DELETE SET NULL, 
	FOREIGN KEY(patient_assignment_id) REFERENCES security_patient_assignments (id) ON DELETE SET NULL, 
	FOREIGN KEY(mcs_node_id) REFERENCES security_mcs_nodes (id) ON DELETE SET NULL
);

CREATE INDEX ix_security_audit_tasks_source_type ON security_audit_tasks (source_type);

CREATE INDEX ix_security_audit_tasks_requested_by_user_id ON security_audit_tasks (requested_by_user_id);

CREATE INDEX ix_security_audit_tasks_task_type ON security_audit_tasks (task_type);

CREATE INDEX ix_security_audit_tasks_patient_assignment_id ON security_audit_tasks (patient_assignment_id);

CREATE INDEX ix_security_audit_tasks_patient_id ON security_audit_tasks (patient_id);

CREATE INDEX ix_security_audit_tasks_mcs_node_id ON security_audit_tasks (mcs_node_id);


CREATE TABLE security_cipher_records (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	patient_id INTEGER NOT NULL, 
	source_type VARCHAR(32) NOT NULL, 
	source_record_id INTEGER, 
	patient_assignment_id INTEGER, 
	mcs_node_id INTEGER, 
	time_bucket VARCHAR(64) NOT NULL, 
	dimension_labels_json JSON NOT NULL, 
	metadata_json JSON NOT NULL, 
	encrypted_payload TEXT NOT NULL, 
	integrity_digest VARCHAR(128) NOT NULL, 
	key_fingerprint VARCHAR(128) NOT NULL, 
	cipher_version VARCHAR(32) NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id) ON DELETE CASCADE, 
	FOREIGN KEY(patient_assignment_id) REFERENCES security_patient_assignments (id) ON DELETE SET NULL, 
	FOREIGN KEY(mcs_node_id) REFERENCES security_mcs_nodes (id) ON DELETE SET NULL
);

CREATE INDEX ix_security_cipher_records_patient_id ON security_cipher_records (patient_id);

CREATE INDEX ix_security_cipher_records_mcs_node_id ON security_cipher_records (mcs_node_id);

CREATE INDEX ix_security_cipher_records_source_record_id ON security_cipher_records (source_record_id);

CREATE INDEX ix_security_cipher_records_patient_assignment_id ON security_cipher_records (patient_assignment_id);

CREATE INDEX ix_security_cipher_records_integrity_digest ON security_cipher_records (integrity_digest);

CREATE INDEX ix_security_cipher_records_time_bucket ON security_cipher_records (time_bucket);

CREATE INDEX ix_security_cipher_records_source_type ON security_cipher_records (source_type);


CREATE TABLE security_audit_logs (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	audit_task_id INTEGER, 
	patient_id INTEGER, 
	actor_user_id INTEGER, 
	action VARCHAR(64) NOT NULL, 
	status VARCHAR(32) NOT NULL, 
	message TEXT NOT NULL, 
	detail_json JSON NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(audit_task_id) REFERENCES security_audit_tasks (id) ON DELETE CASCADE, 
	FOREIGN KEY(patient_id) REFERENCES patients (id) ON DELETE CASCADE, 
	FOREIGN KEY(actor_user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX ix_security_audit_logs_action ON security_audit_logs (action);

CREATE INDEX ix_security_audit_logs_patient_id ON security_audit_logs (patient_id);

CREATE INDEX ix_security_audit_logs_audit_task_id ON security_audit_logs (audit_task_id);

CREATE INDEX ix_security_audit_logs_actor_user_id ON security_audit_logs (actor_user_id);

SET FOREIGN_KEY_CHECKS=1;

