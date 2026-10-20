"""One authenticated model family pointer and append-only version history."""
from datetime import datetime,timezone
from sqlalchemy import DateTime,ForeignKey,Integer,String,UniqueConstraint,event,inspect
from sqlalchemy.orm import Mapped,mapped_column
from backend.app.db.base import Base
from backend.app.core.data_encryption import EncryptedValue,scoped_key
from backend.app.core.record_envelope import RecordIntegrityError
import hashlib,hmac,json


def state(row):
    return {key:getattr(row,key) for key in row.authenticated_fields}


def tag(row):
    return hmac.new(scoped_key('model-registry'),json.dumps(state(row),sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode(),hashlib.sha256).hexdigest()


class ModelRegistry(Base):
    __tablename__='model_registry'
    authenticated_fields=('family','active_version_id','revision','ledger_key','latest_action_id','history_digest')
    family:Mapped[str]=mapped_column(String(64),primary_key=True)
    active_version_id:Mapped[int|None]=mapped_column(ForeignKey('model_versions.id'),nullable=True)
    revision:Mapped[int]=mapped_column(Integer,default=1)
    ledger_key:Mapped[str]=mapped_column(String(64),unique=True)
    state_tag:Mapped[str]=mapped_column(String(64))
    latest_action_id:Mapped[int|None]=mapped_column(Integer,nullable=True)
    history_digest:Mapped[str]=mapped_column(String(64))


class ModelVersion(Base):
    __tablename__='model_versions'
    authenticated_fields=('family','version','artifact_sha256','actor_user_id','manifest')
    __table_args__=(UniqueConstraint('family','version',name='uq_registered_model_version'),)
    id:Mapped[int]=mapped_column(primary_key=True)
    family:Mapped[str]=mapped_column(String(64),index=True)
    version:Mapped[str]=mapped_column(String(64))
    artifact_sha256:Mapped[str]=mapped_column(String(64))
    actor_user_id:Mapped[int]=mapped_column(ForeignKey('users.id'))
    manifest:Mapped[dict]=mapped_column(EncryptedValue('model_versions.manifest','json'))
    state_tag:Mapped[str]=mapped_column(String(64))
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=lambda:datetime.now(timezone.utc))


class ModelRegistryAction(Base):
    __tablename__='model_registry_actions'
    authenticated_fields=('family','version_id','actor_user_id','client_action_id','action','payload','authority_snapshot')
    id:Mapped[int]=mapped_column(primary_key=True)
    family:Mapped[str]=mapped_column(String(64),index=True)
    version_id:Mapped[int]=mapped_column(ForeignKey('model_versions.id'))
    actor_user_id:Mapped[int]=mapped_column(ForeignKey('users.id'))
    client_action_id:Mapped[str]=mapped_column(String(64),unique=True)
    action:Mapped[str]=mapped_column(String(32))
    payload:Mapped[dict]=mapped_column(EncryptedValue('model_registry_actions.payload','json'))
    authority_snapshot:Mapped[list]=mapped_column(EncryptedValue('model_registry_actions.authority_snapshot','json'))
    state_tag:Mapped[str]=mapped_column(String(64))
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=lambda:datetime.now(timezone.utc))


def verify(row,*args):
    if not hmac.compare_digest(row.state_tag,tag(row)):raise RecordIntegrityError('The authenticated model version or activation pointer changed.')


def immutable(mapper,connection,row):
    if any(attr.history.has_changes() for attr in inspect(row).attrs):raise ValueError('Model versions and registry actions are append-only.')


for model in (ModelRegistry,ModelVersion,ModelRegistryAction):
    event.listen(model,'before_insert',lambda mapper,connection,row:verify(row))
    event.listen(model,'load',verify);event.listen(model,'refresh',verify)
    event.listen(model,'before_delete',lambda *args:(_ for _ in ()).throw(ValueError('Model version history cannot be deleted.')))
    if model is not ModelRegistry:event.listen(model,'before_update',immutable)
