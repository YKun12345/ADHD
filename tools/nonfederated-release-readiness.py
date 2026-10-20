"""Offline non-federated release checks. Exit 2 means release evidence is incomplete.

No default database connection, service startup, token exchange, model loading or
credential validation occurs. --env-file is selected explicitly and does not
inherit process values. Only --sqlite-schema opens a database, in mode=ro.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def check(status, *reasons, **details):
    return {'status': status, 'reason_codes': list(reasons), **details}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def valid_key(value):
    try:
        return len(base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)) == 32
    except (ValueError, TypeError):
        return False


def read_sqlite_schema(path):
    """Read schema only; never resolve DATABASE_URL or query business rows."""
    path = Path(path).resolve()
    if not path.is_file():
        return check('blocked', 'sqlite_file_missing')
    # Settings imported by model types must not load backend/.env or use real stores.
    os.environ.update(APP_ENV='migration', DATABASE_URL='sqlite:///:memory:')
    sys.path.insert(0, str(ROOT))
    from sqlalchemy import create_engine, inspect
    import backend.app.models  # noqa: F401
    from backend.app.db.base import Base
    from backend.app.db.care_migration import _missing_constraints

    def connect():
        conn = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
        conn.execute('PRAGMA query_only=ON')
        return conn

    engine = create_engine('sqlite://', creator=connect)
    try:
        inspector = inspect(engine)
        existing = set(inspector.get_table_names())
        required = [table for table in Base.metadata.sorted_tables if not table.name.startswith('federated_')]
        missing_tables, missing_columns, missing_constraints = [], {}, {}
        for table in required:
            if table.name not in existing:
                missing_tables.append(table.name)
                continue
            missing = sorted(set(table.c.keys()) - {column['name'] for column in inspector.get_columns(table.name)})
            if missing:
                missing_columns[table.name] = missing
            constraints = _missing_constraints(inspector, table)
            if constraints:
                missing_constraints[table.name] = constraints
        blocked = bool(missing_tables or missing_columns or missing_constraints)
        return check('blocked' if blocked else 'pass', *(['required_schema_missing'] if blocked else []),
            scope='SQLite metadata only; no data conversion, authorization or MySQL compatibility proof',
            dialect='sqlite', table_count_checked=len(required), missing_tables=sorted(missing_tables),
            missing_columns=missing_columns, missing_constraints=missing_constraints, rows_read=False)
    finally:
        engine.dispose()


def model_check(artifact):
    sources = ['HGST-main/README.md', 'HGST-main/src/corr.py', 'HGST-main/src/getData.py',
        'HGST-main/constr_edges_sparse.py', 'backend/app/services/hgst_runtime/preprocessing.py']
    hashes = {name: digest(ROOT / name) if (ROOT / name).is_file() else None for name in sources}
    candidate = Path(artifact).resolve() if artifact else ROOT / 'backend/models/hgst_adhd_bundle.pt'
    current = {'present': candidate.is_file(), 'sha256': digest(candidate) if candidate.is_file() else None}
    comparison_path = ROOT / 'docs/evidence/w09-storage-admission-spec-input-difference.json'
    comparison = {}
    try:
        old = json.loads(comparison_path.read_text(encoding='utf8'))
        matched = bool(old.get('sources')) and all(hashes.get(name) == value for name, value in old['sources'].items())
        comparison = {'source_hashes_match_saved_counterexample': matched,
            'saved_features_equivalent': old.get('comparison', {}).get('features_equivalent_rtol_1e_6_atol_1e_6'),
            'saved_max_abs_difference': old.get('comparison', {}).get('feature_max_abs_difference'),
            'proof_of_actual_weight_training_contract': False}
    except (OSError, ValueError, TypeError):
        comparison = {'source_hashes_match_saved_counterexample': False}
    readme = ROOT / sources[0]
    restricted = readme.is_file() and 'free for research and education use only' in readme.read_text(encoding='utf8')
    return check('blocked', 'weight_training_provenance_unverified', 'independent_weight_and_data_permissions_unverified',
        'actual_training_numeric_reference_missing', 'intended_use_approval_missing', 'trusted_registry_and_instance_proofs_not_checked',
        artifact=current, source_sha256=hashes, input_counterexample=comparison,
        upstream_research_education_restriction_declared=restricted,
        real_inference_allowed=False, weights_loaded=False, R03_closed=False, R15_closed=False)


def build_report(values, *, sqlite_schema=None, artifact=None):
    def value(name, default=''):
        return str(values.get(name) or default).strip()

    def enabled(name):
        return value(name).lower() == 'true'

    environment_reasons = []
    if value('APP_ENV').lower() != 'production':
        environment_reasons.append('production_environment_not_selected')
    secret = value('SECRET_KEY')
    if len(secret) < 32 or secret.lower().startswith(('change-me', 'placeholder', 'example')):
        environment_reasons.append('signing_key_not_production_shaped')
    key_ok = valid_key(value('DATA_ENCRYPTION_KEY'))
    if not key_ok:
        environment_reasons.append('encryption_key_not_valid_inline_shape_or_external_key_not_checked')
    db_url = value('DATABASE_URL')
    try:
        parsed = urlsplit(db_url)
        db_configured = bool(parsed.scheme and (parsed.path or parsed.hostname))
    except ValueError:
        db_configured = False
    if not db_configured:
        environment_reasons.append('explicit_database_url_missing_or_invalid')
    public_url = value('PUBLIC_API_BASE_URL')
    try:
        public = urlsplit(public_url)
        https_shaped = bool(public.scheme == 'https' and public.hostname and not public.username and
            not public.password and not public.query and not public.fragment and public.path in ('', '/'))
    except ValueError:
        https_shaped = False
    names = {'app_id': 'WECHAT_APP_ID', 'app_secret': 'WECHAT_APP_SECRET',
        'template_id': 'WECHAT_SUBSCRIBE_TEMPLATE_ID', 'title_field': 'WECHAT_SUBSCRIBE_TITLE_FIELD',
        'time_field': 'WECHAT_SUBSCRIBE_TIME_FIELD'}
    configured = {key: bool(value(name)) for key, name in names.items()}
    reasons = ['missing_' + key for key, present in configured.items() if not present]
    if not re.fullmatch(r'thing[1-9][0-9]*', value(names['title_field'])) or not re.fullmatch(r'time[1-9][0-9]*', value(names['time_field'])):
        reasons.append('template_field_mapping_invalid')
    if value('WECHAT_MINIPROGRAM_STATE', 'formal') not in {'developer', 'trial', 'formal'}:
        reasons.append('miniprogram_state_invalid')
    sending, worker = enabled('WECHAT_NOTIFICATION_SEND_ENABLED'), enabled('WECHAT_NOTIFICATION_WORKER_ENABLED')
    checks = {
        'environment_configuration': check('blocked' if environment_reasons else 'pass', *environment_reasons,
            scope='configuration syntax only; never credential authenticity',
            encryption_inline_key_shape_valid=key_ok, external_key_file_contents_read=False,
            authorization_ledger_path_configured=bool(value('AUTHORIZATION_LEDGER_PATH'))),
        'live_database_credentials': check('not_checked', 'no_network_database_connection_attempted'),
        'database_schema': read_sqlite_schema(sqlite_schema) if sqlite_schema else check('not_checked', 'explicit_sqlite_schema_path_not_selected'),
        'mysql_schema_and_conversion': check('not_checked', 'requires_explicit_target_readonly_plan_and_reviewed_rehearsal'),
        'https_configuration': check('pass' if https_shaped else 'blocked', *([] if https_shaped else ['https_public_origin_missing_or_invalid']), scope='URL syntax only'),
        'https_live_and_wechat_domains': check('not_checked', 'certificate_chain_health_and_wechat_allowlist_not_probed'),
        'wechat_configuration': check('blocked' if reasons else 'pass', *reasons, configured=configured,
            scope='presence and field syntax only; AppID ownership, secret and template validity unverified'),
        'worker_enable_gate': check('blocked' if sending or worker else 'pass',
            *(['enabled_without_release_acceptance_evidence'] if sending or worker else ['delivery_and_worker_safely_disabled']),
            send_enabled=sending, worker_enabled=worker,
            required_before_enabling=['reviewed_schema_and_independent_ledger', 'verified_https_and_wechat_account_template',
                'authorized_release_and_backup_restore', 'actual_user_code_binding_and_one_time_permission',
                'controlled_new_event_and_real_device_receipt']),
        'wechat_live_delivery': check('not_checked', 'no_real_binding_permission_or_send_attempt',
            one_time_permission_is_not_inferred_from_environment=True),
        'model_admission': model_check(artifact),
        'independent_authorization_ledger': check('not_checked', 'must_be_provisioned_and_reconciled_independently_never_seeded_from_business_backup'),
        'backup_restore_and_rollback': check('not_checked', 'target_database_upload_key_and_independent_ledger_recovery_not_rehearsed'),
        'deployment_and_real_device_acceptance': check('not_checked', 'no_release_authorization_or_target_device_receipt'),
        'federated_scope': check('pass' if not enabled('FEDERATED_WORKER_ENABLED') else 'blocked',
            'federated_worker_disabled' if not enabled('FEDERATED_WORKER_ENABLED') else 'out_of_scope_worker_enabled'),
    }
    packages = {}
    for name in ('SQLAlchemy', 'cryptography', 'numpy', 'scikit-learn', 'nilearn', 'torch', 'dhg'):
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = None
    return {'report_version': 1, 'generated_at': datetime.now(timezone.utc).isoformat(),
        'scope': 'offline_nonfederated_release_readiness', 'release_status': 'blocked',
        'configuration_source': 'explicit_env_file_only' if values is not os.environ else 'process_environment_only',
        'checks': checks, 'runtime_packages': packages,
        'effects': {'database_writes': False, 'network_requests': False, 'weights_loaded': False,
            'workers_started': False, 'activation_performed': False}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, help='Explicit file only; no process override and no interpolation')
    parser.add_argument('--sqlite-schema', type=Path, help='Existing file, schema metadata read in mode=ro; never DATABASE_URL')
    parser.add_argument('--artifact', type=Path, help='Optional actual candidate to hash without deserializing')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        if args.env_file:
            from dotenv import dotenv_values
            if not args.env_file.is_file():
                raise ValueError('env_file_missing')
            values = dotenv_values(args.env_file, interpolate=False)
        else:
            values = os.environ
        report = build_report(values, sqlite_schema=args.sqlite_schema, artifact=args.artifact)
    except Exception:
        # Raw exceptions can include credentials, connection URLs or private paths.
        report = {'report_version': 1, 'release_status': 'blocked',
            'checks': {'preflight_execution': check('blocked', 'preflight_failed_without_secret_details')}}
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.write_text(rendered, encoding='utf8')
    print(rendered, end='')
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
