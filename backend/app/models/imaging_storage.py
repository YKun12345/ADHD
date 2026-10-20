"""Shared image storage hooks; business provenance is never inferred from AEAD."""
from datetime import datetime, timezone
from sqlalchemy import event, inspect
from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.core.record_fields import register_record_fields


def canonical_metadata(row):
    values = {}
    for name in row.storage_metadata_fields:
        value = getattr(row, name)
        if name == 'created_at' and value is not None:
            if isinstance(value, str):
                value = datetime.fromisoformat(value)
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            value = value.astimezone(timezone.utc).isoformat(timespec='microseconds')
        values[name] = value
    return values


def initialize_values(row, values):
    # Explicit None is a real value in the complete encrypted record, including
    # fields omitted by historical fixtures and trusted internal callers.
    for field in row.record_fields:
        if field != 'storage_context':
            values.setdefault(field, None)
    # The existing MySQL DATETIME columns have second precision. Save that
    # exact value before authenticating it; saved_at in the envelope retains
    # the precise API save timestamp independently of driver truncation.
    values.setdefault('created_at', datetime.now(timezone.utc).replace(microsecond=0))
    values.setdefault('storage_context', {
        'context_version': 1, 'actor_user_id': None, 'authority_receipts': [],
        'source_binding_status': 'not_recorded',
        'source_binding_retroactively_proven': None,
        'professional_review_status': 'not_recorded', 'input': {'kind': 'not_recorded'},
    })
    for name, value in values.items():
        setattr(row, name, value)


def verify_storage_metadata(row):
    pending = row.__dict__.get('_pending_record_values',{})
    for field in row.record_fields:
        if field not in pending and getattr(row,'_'+field+'_cipher') is None:
            raise RecordIntegrityError('Image values, including null values, require an authenticated envelope.')
    context = row.storage_context
    if not isinstance(context, dict) or context.get('metadata') != canonical_metadata(row):
        raise RecordIntegrityError('Image source metadata does not match authenticated storage context.')


def register_imaging_storage(model, *, immutable=False):
    def prepare_insert(mapper, connection, row):
        context = row.storage_context
        context['metadata'] = canonical_metadata(row)
        row.storage_context = context

    def prepare_update(mapper, connection, row):
        state = inspect(row)
        changed = any(state.attrs[col.key].history.has_changes() for col in state.mapper.column_attrs)
        if immutable and (changed or row.__dict__.get('_pending_record_values')):
            raise ValueError('Committed model predictions are immutable; append a new result.')
        if changed:
            pending = row.__dict__.get('_pending_record_values',{})
            if row.storage_context.get('source_binding_status') == 'authenticated_api_write' and 'storage_context' not in pending:
                raise ValueError('An image update requires the current saving actor and authenticated context.')
            verify_storage_metadata(row)

    def protect_delete(mapper, connection, row):
        raise ValueError('Committed model predictions are immutable; append-only retention applies.')

    event.listen(model, 'before_insert', prepare_insert)
    event.listen(model, 'before_update', prepare_update)
    if immutable:
        event.listen(model, 'before_delete', protect_delete)
    register_record_fields(model)
    event.listen(model, 'load', lambda row, context: verify_storage_metadata(row))
    event.listen(model, 'refresh', lambda row, context, attrs: verify_storage_metadata(row))
