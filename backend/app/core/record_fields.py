"""Raw mapped columns plus explicit complete-row binding, without column-only guesses."""
from copy import deepcopy
from sqlalchemy import Integer, String, event, inspect, update
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.orm.attributes import set_committed_value

from backend.app.core.record_envelope import RecordBinding, RecordIntegrityError, open_record, seal_record, origin_binding, seal_origin
from backend.app.core.record_provenance import record_storage_type


class RecordFieldsMixin:
    record_schema_version: Mapped[int] = mapped_column(Integer,default=2,server_default="1")
    data_version: Mapped[int] = mapped_column(Integer,default=1,server_default="1")
    record_key_version: Mapped[int] = mapped_column(Integer,default=1,server_default="1")
    envelope_status: Mapped[str] = mapped_column(String(32),default="bound",server_default="legacy")
    _origin_cipher: Mapped[str | None] = mapped_column("record_origin",record_storage_type(),nullable=True)

    @property
    def record_origin(self):
        # Existing audited source hashing enumerates physical column names.
        return self._origin_cipher

    def _binding(self,field):
        return RecordBinding(self.patient_id,self.record_object_type,self.id,field,
            self.record_schema_version,self.data_version,self.record_key_version)

    def _verify_origin(self):
        proof = open_record(self._origin_cipher, origin_binding(self.patient_id,self.record_object_type,self.id))
        expected = {"record_schema_version":self.record_schema_version,"data_version":self.data_version,
            "record_key_version":self.record_key_version,"envelope_status":self.envelope_status}
        if proof != expected or self.envelope_status not in {"bound","migrated_from_legacy"}:
            raise RecordIntegrityError("Storage provenance or format markers do not match authenticated origin; legacy data requires reviewed explicit conversion.")

    def _seal_origin(self):
        return seal_origin(self.patient_id,self.record_object_type,self.id,schema_version=self.record_schema_version,
            data_version=self.data_version,key_version=self.record_key_version,status=self.envelope_status)


def record_field(name):
    storage = "_"+name+"_cipher"
    def get_value(row):
        pending = row.__dict__.get("_pending_record_values",{})
        if name in pending:
            return deepcopy(pending[name])
        row._verify_origin()
        raw = getattr(row,storage)
        if raw is None:
            return None
        if row.envelope_status not in {"bound","migrated_from_legacy"}:
            raise RecordIntegrityError("Record binding status is unknown.")
        return open_record(raw,row._binding(name))
    def set_value(row,value):
        # A committed instance may have expired binding columns. Load those
        # before creating a new edit, so their lazy refresh cannot discard it.
        if inspect(row).persistent:
            row._verify_origin()
        row.__dict__.setdefault("_pending_record_values",{})[name] = deepcopy(value)
        # The temporary placeholder exists only within an uncommitted insert or
        # update; mapper hooks replace it after the real primary key is known.
        setattr(row,storage,"")
    return property(get_value,set_value)


def _insert(mapper,connection,row):
    row.record_schema_version = 2
    row.data_version = 1
    row.record_key_version = 1
    row.envelope_status = "bound"
    pending = row.__dict__.get("_pending_record_values",{})
    if set(pending) != set(row.record_fields):
        raise RecordIntegrityError("Every new sensitive field must have an actual value before insert.")


def _after_insert(mapper,connection,row):
    values = {}
    for field,value in row.__dict__["_pending_record_values"].items():
        cipher = seal_record(value,row._binding(field))
        values[field] = cipher
        set_committed_value(row,"_"+field+"_cipher",cipher)
    proof = row._seal_origin()
    values["record_origin"] = proof
    set_committed_value(row,"_origin_cipher",proof)
    connection.execute(update(row.__table__).where(row.__table__.c.id == row.id).values(**values))
    row.__dict__.pop("_pending_record_values",None)


def _update(mapper,connection,row):
    pending = row.__dict__.get("_pending_record_values",{})
    if not pending:
        return
    row._verify_origin()
    # Decode all unchanged fields under the original version before incrementing.
    plain = {field:pending[field] if field in pending else getattr(row,field) for field in row.record_fields}
    row.data_version += 1
    row.record_schema_version = 2
    for field,value in plain.items():
        setattr(row,"_"+field+"_cipher",seal_record(value,row._binding(field)))
    row._origin_cipher = row._seal_origin()
    row.__dict__.pop("_pending_record_values",None)


def _discard_pending_values(row, attributes):
    """Keep transient edits subject to the same discard boundaries as mapped data."""
    # SQLAlchemy can expire a weakly referenced instance during rollback
    # after its Python object was collected. There is no plaintext cache left.
    if row is None:
        return
    pending = row.__dict__.get("_pending_record_values")
    if not pending:
        return
    if attributes is None:
        row.__dict__.pop("_pending_record_values",None)
        return
    attributes = set(attributes)
    binding_fields = {"id","patient_id","record_schema_version","data_version",
        "record_key_version","envelope_status","_origin_cipher","record_origin"}
    discard = set(pending) if attributes & binding_fields else {
        name for name in pending if name in attributes or "_"+name+"_cipher" in attributes}
    for name in discard:
        pending.pop(name,None)
    if not pending:
        row.__dict__.pop("_pending_record_values",None)
    # Expiring only provenance also discards dependent edits. Expire their
    # placeholders so a later flush/read cannot mistake them for saved ciphers.
    dependent = ["_"+name+"_cipher" for name in discard
        if "_"+name+"_cipher" not in attributes and "_"+name+"_cipher" in row.__dict__]
    if dependent:
        session = inspect(row).session
        if session is not None:
            session.expire(row,dependent)


def register_record_fields(model):
    event.listen(model,"before_insert",_insert)
    event.listen(model,"after_insert",_after_insert)
    event.listen(model,"before_update",_update)
    event.listen(model,"expire",_discard_pending_values)
    def discard_refreshed_values(row,context,attributes):
        _discard_pending_values(row,attributes)
    event.listen(model,"refresh",discard_refreshed_values)
    def validate_loaded(row,*args):
        # Validate complete loaded rows without retaining decrypted plaintext.
        # This also keeps source-authentication failures inside the existing
        # audited source loader's failure boundary.
        if row.__dict__.get("_validating_record_fields"):
            return
        row.__dict__["_validating_record_fields"] = True
        try:
            unloaded = inspect(row).unloaded
            for name in row.record_fields:
                if "_"+name+"_cipher" not in unloaded:
                    getattr(row,name)
        finally:
            row.__dict__.pop("_validating_record_fields",None)
    event.listen(model,"load",validate_loaded)
    event.listen(model,"refresh",validate_loaded)
