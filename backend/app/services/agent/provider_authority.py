"""Freeze the explicit external purpose at enqueue; never borrow a later grant."""
from fastapi import HTTPException
from backend.app.services.consent_service import current_consent, has_consent

MESSAGE_POLICY = 'Xingzai-current-message-1'
DIALOGUE_POLICY = 'Xingzai-selected-dialogue-1'
MAX_DIALOGUE_CHARACTERS = 4000


def validate_dialogue_ids(identifiers):
    if identifiers is None:
        return []
    if (not isinstance(identifiers, list) or len(identifiers) > 2 or
            any(type(value) is not int or value <= 0 for value in identifiers) or
            len(identifiers) != len(set(identifiers))):
        raise HTTPException(422, 'Select up to two distinct positive completed question run IDs.')
    return identifiers


def validate_dialogue_preview(preview, identifiers):
    """Validate the frozen server representation before it can become model text."""
    from backend.app.services.cognitive_contract import canonical_digest
    identifiers = validate_dialogue_ids(identifiers)
    if not identifiers or not isinstance(preview, dict) or set(preview) != {'policy_version', 'turns', 'digest'}:
        raise HTTPException(409, 'The selected dialogue has no exact server preview.')
    turns = preview.get('turns')
    if preview['policy_version'] != DIALOGUE_POLICY or not isinstance(turns, list) or len(turns) != len(identifiers):
        raise HTTPException(409, 'The selected dialogue preview policy or sources changed.')
    for identifier, turn in zip(identifiers, turns):
        if (not isinstance(turn, dict) or set(turn) != {'run_id', 'user_message', 'assistant_message'} or
                type(turn['run_id']) is not int or turn['run_id'] != identifier or
                any(not isinstance(turn[field], str) or not turn[field].strip() for field in ('user_message', 'assistant_message'))):
            raise HTTPException(409, 'The selected dialogue preview differs from its complete original turns.')
    if sum(len(turn[field]) for turn in turns for field in ('user_message', 'assistant_message')) > MAX_DIALOGUE_CHARACTERS:
        raise HTTPException(422, 'Selected dialogue exceeds 4000 characters; select fewer conversations.')
    if preview['digest'] != canonical_digest({key: preview[key] for key in ('policy_version', 'turns')}):
        raise HTTPException(409, 'The selected dialogue preview digest changed.')
    return preview


def external_scopes(frame):
    scopes = set()
    if frame['assessments']:
        scopes.add('assessment')
    if frame['cycles'] or frame['plans']:
        scopes.add('tracking')
    return sorted(scopes)


def external_snapshot(db, patient_id, frame, *, field_policy=None):
    # Explicit dialogue policies never export profile, assessments or reports.
    scopes = ['care'] if field_policy in {MESSAGE_POLICY, DIALOGUE_POLICY} else external_scopes(frame)
    if not scopes or not has_consent(db, patient_id, 'external_ai', scope=scopes):
        return None
    row = current_consent(db, patient_id, 'external_ai')
    return {'id': row.id, 'authority_id': row.authority_id, 'ledger_key': row.ledger_key, 'revision': row.revision,
        'purpose': 'external_ai', 'patient_id': patient_id, 'required_scopes': scopes, 'granted_scopes': sorted(row.scope),
        'grantor_user_id': row.grantor_user_id, 'actor_identity_basis': row.actor_identity_basis, 'terms_version': row.terms_version,
        'expires_at': row.expires_at.isoformat() if row.expires_at else None,
        'field_policy_version': field_policy or 'W08-structured-counts-and-refs-1'}


def check_external(db, patient_id, frame, original):
    if original is None or external_snapshot(db, patient_id, frame, field_policy=original.get('field_policy_version')) != original:
        raise HTTPException(403, 'The original scoped external AI purpose is absent, expired, withdrawn or replaced.')
