"""Only the policy counterexamples changed by the P2A comparison slice."""
from copy import deepcopy
import importlib


def base(kind='scale'):
    return {'patient_id': 1, 'submission_id': 'one', 'kind': kind, 'instrument': 'ASRS' if kind == 'scale' else 'reaction',
        'protocol_id': 'actual-protocol', 'protocol_schema_version': 1, 'config_digest': 'same-config',
        'content_digest': 'same-wording', 'age_group': 'adult', 'source': 'self', 'performer_kind': 'user',
        'performer_user_id': 1, 'performer_patient_id': None, 'respondent_user_id': 1, 'respondent_kind': 'self',
        'recall_window': 'P6M' if kind == 'scale' else None, 'quality_status': 'valid', 'demonstration_only': True,
        'professional_approval': None, 'started_at': '2026-10-01T00:00:00+00:00', 'metrics': {'total_score': 0},
        'device': {'platform': 'miniprogram', 'device_type': 'phone'}, 'input': {'method': 'touch'},
        'timing': {'calibrated': True}, 'practice': {'completed': True, 'attempts': 1, 'exposure_count': 0},
        'assistance': {'provided': False}, 'prior_started_attempt_count': 0}


def test_same_protocol_fourteen_day_recall_overlap_and_changed_observer():
    compare = importlib.import_module('backend.app.services.comparison_service').compare_measurements
    left = base()
    right = {**deepcopy(left), 'submission_id': 'two', 'started_at': '2026-10-15T00:00:00+00:00', 'metrics': {'total_score': 20}}
    result = compare(left, right)
    assert result['status'] == 'limited' and result['interval_days'] == 14
    assert 'P6M_window_overlap' in [row['code'] for row in result['reasons']]
    assert result['numeric_changes'] == [] and result['treatment_effect_conclusion_allowed'] is False
    right['respondent_user_id'] = 2
    assert compare(left, right)['status'] == 'not_comparable'


def test_matching_device_is_not_calibration_and_changed_device_not_comparable():
    compare = importlib.import_module('backend.app.services.comparison_service').compare_measurements
    left = base('cognitive')
    right = {**deepcopy(left), 'submission_id': 'two', 'started_at': '2026-11-01T00:00:00+00:00'}
    result = compare(left, right)
    assert result['status'] == 'limited'
    assert 'device_equivalence_not_verified' in [row['code'] for row in result['reasons']]
    right['device']['device_type'] = 'desktop'
    assert compare(left, right)['status'] == 'not_comparable'
