"""Storage provenance is independent of a record's legacy business context."""
from sqlalchemy import Text, event, inspect, select
from sqlalchemy.dialects.mysql import LONGTEXT


def record_storage_type():
    return Text().with_variant(LONGTEXT(),"mysql")


def record_storage_info(row):
    legacy = row.envelope_status == "legacy"
    return {"status":"legacy_column_aad" if legacy else row.envelope_status,
        "format":"aesgcm:v1" if legacy else "aesgcm:v2",
        "schema_version":row.record_schema_version,"data_version":row.data_version,
        "key_version":row.record_key_version,
        "source_binding_retroactively_proven":False if row.envelope_status in {"legacy","migrated_from_legacy"} else None}


def register_immutable_formal_result(model):
    """Legacy storage upgrades remain possible; committed formal results are append-only."""
    def protect_formal_result(mapper, connection, row):
        state = inspect(row)
        if not any(state.attrs[column.key].history.has_changes() for column in state.mapper.column_attrs):
            return
        # Use the original persistent identity and database flag. A caller must
        # not evade the guard by changing id or legacy in this same ORM update.
        original_id = state.identity[0]
        table = model.__table__
        original = connection.execute(select(table.c.legacy, table.c.assessment_id,
            table.c.assessment_item_id, table.c.task_attempt_id).where(table.c.id == original_id)).one()
        if not original.legacy or any(value is not None for value in original[1:]) or state.attrs.legacy.history.has_changes():
            raise ValueError("Committed formal result and legacy provenance are immutable; save a new attempt/result instead.")
    event.listen(model, "before_update", protect_formal_result)
