"""A parsable model request never grants access to another object or operation."""
from fastapi import HTTPException
from backend.app.services.cognitive_contract import canonical_digest

READ_TOOLS = frozenset({'get_current_tasks', 'get_progress', 'get_authorized_evidence', 'suggest_next_action'})
DRAFT_TOOLS = frozenset({'draft_profile_fields', 'draft_assessment_summary', 'draft_cycle_summary',
    'draft_review_questions', 'draft_plan', 'draft_reply'})
DOCTOR_TOOLS = frozenset({'draft_review_questions', 'draft_plan', 'draft_reply'})


def validate_tool(frame, name, arguments):
    if name not in READ_TOOLS | DRAFT_TOOLS or not isinstance(arguments, dict):
        raise HTTPException(403, 'This Agent operation is not a permitted business tool.')
    if any(key not in {'patient_id', 'assessment_id', 'cycle_id'} for key in arguments):
        raise HTTPException(422, 'Agent tool arguments contain unsupported identity, authority or operation fields.')
    if arguments.get('patient_id', frame['patient_id']) != frame['patient_id']:
        raise HTTPException(403, 'Agent tools cannot choose a different patient profile.')
    if name in DOCTOR_TOOLS and frame['role'] != 'researcher':
        raise HTTPException(403, 'This editable draft is available only to the actual doctor workspace.')
    if name == 'draft_profile_fields' and frame['role'] != 'patient':
        raise HTTPException(403, 'Only the actual user can prepare their own optional background draft.')
    if name == 'draft_profile_fields' and 'profile' not in frame['authorized_scopes']:
        raise HTTPException(403, 'Optional background requires the actual profile authority before processing.')
    aid, cycle_id = arguments.get('assessment_id'), arguments.get('cycle_id')
    if aid is not None and (type(aid) is not int or not any(row['id'] == aid for row in frame['assessments'])):
        raise HTTPException(403, 'This assessment is outside the current authorized Agent evidence.')
    if name in DOCTOR_TOOLS and not any(row['responsible_doctor_id'] == frame['actor_user_id'] and
            (aid is None or row['id'] == aid) for row in frame['assessments']):
        raise HTTPException(403, 'This professional draft requires the actual responsible doctor evidence.')
    if name == 'draft_plan' and not any(row['responsible_doctor_id'] == frame['actor_user_id'] and
            (aid is None or row['id'] == aid) and row['reports'] for row in frame['assessments']):
        raise HTTPException(422, 'An actual published doctor opinion is required before drafting its plan.')
    if cycle_id is not None and (type(cycle_id) is not int or not any(row['id'] == cycle_id for row in frame['cycles'])):
        raise HTTPException(403, 'This cycle is outside the current authorized Agent evidence.')


def source_refs(frame):
    result = [row['source_ref'] for row in frame['assessments']]
    result.extend(item['source_ref'] for row in frame['assessments'] for item in row['submissions'])
    result.extend(f'report:{item["id"]}:{item["version"]}:{item["input_digest"]}' for row in frame['assessments'] for item in row['reports'])
    result.extend(f'plan:{row["id"]}:{row["revision"]}' for row in frame['plans'])
    result.extend(f'cycle:{row["id"]}:{canonical_digest(row["summary"])}' for row in frame['cycles'])
    return sorted(set(result)) or [f'profile_access:{frame["patient_id"]}:{canonical_digest(frame["authorization_snapshot"])}']


def validate_artifact(frame, body, references):
    if not isinstance(body, dict) or not isinstance(references, list) or not references or not set(references) <= set(source_refs(frame)):
        raise HTTPException(422, 'Agent draft has missing or unrecognized evidence references.')
    if body.get('status') != 'draft' or body.get('requires_human_confirmation') is not True:
        raise HTTPException(422, 'Agent output cannot become an approved professional publication.')
    if body.get('model_evidence_status') != 'not_admitted':
        raise HTTPException(422, 'An Agent draft cannot admit a model or unverified probability.')
