from datetime import datetime
from sqlalchemy import ForeignKey,String,Integer,DateTime,UniqueConstraint,event
from sqlalchemy.orm import Mapped,mapped_column
from backend.app.db.base import Base
from backend.app.models.federated import BoundObject,immutable


class FederatedExperiment(BoundObject,Base):
    __tablename__='federated_experiments'
    id:Mapped[str]=mapped_column(String(64),primary_key=True)
    project_id:Mapped[int]=mapped_column(ForeignKey('federated_projects.id'),index=True)
    actor_user_id:Mapped[int]=mapped_column(ForeignKey('users.id'),index=True)
    status:Mapped[str]=mapped_column(String(32),index=True)
    active_slot:Mapped[int|None]=mapped_column(Integer,unique=True,nullable=True)
    lease_owner:Mapped[str|None]=mapped_column(String(64),nullable=True)
    lease_expires_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True),nullable=True)


class FederatedRound(BoundObject,Base):
    __tablename__='federated_rounds'
    __table_args__=(UniqueConstraint('experiment_id','round_number','attempt',name='uq_federated_round_attempt'),)
    id:Mapped[str]=mapped_column(String(64),primary_key=True)
    experiment_id:Mapped[str]=mapped_column(ForeignKey('federated_experiments.id'),index=True)
    round_number:Mapped[int]=mapped_column(Integer)
    attempt:Mapped[str]=mapped_column(String(64))
    status:Mapped[str]=mapped_column(String(32))


class FederatedParticipation(BoundObject,Base):
    __tablename__='federated_participations'
    __table_args__=(UniqueConstraint('round_id','node_id',name='uq_federated_round_node'),)
    id:Mapped[str]=mapped_column(String(64),primary_key=True)
    round_id:Mapped[str]=mapped_column(ForeignKey('federated_rounds.id'),index=True)
    node_id:Mapped[str]=mapped_column(ForeignKey('federated_nodes.id'),index=True)


class FederatedPrivacyLedger(BoundObject,Base):
    __tablename__='federated_privacy_ledgers'
    id:Mapped[str]=mapped_column(String(64),primary_key=True)
    protection_namespace:Mapped[str]=mapped_column(String(255),index=True)


class FederatedModelVersion(BoundObject,Base):
    __tablename__='federated_model_versions'
    id:Mapped[int]=mapped_column(ForeignKey('model_versions.id'),primary_key=True,autoincrement=False)
    project_id:Mapped[int]=mapped_column(ForeignKey('federated_projects.id'),index=True)
    experiment_id:Mapped[str]=mapped_column(ForeignKey('federated_experiments.id'),index=True)


for model in (FederatedParticipation,FederatedModelVersion):
    event.listen(model,'before_update',immutable);event.listen(model,'before_delete',immutable)
