"""Research extensions reference the existing project/member consent authorities."""
from datetime import datetime,timezone
from uuid import uuid4
from sqlalchemy import ForeignKey,String,Integer,Text,DateTime,UniqueConstraint,event
from sqlalchemy.orm import Mapped,mapped_column
from backend.app.db.base import Base
from backend.app.models.identity import AuthorityMixin
from backend.app.core.federated_envelope import FederatedBinding,seal,open_sealed


class BoundObject:
    institution_id:Mapped[str]=mapped_column(String(64),index=True)
    version:Mapped[int]=mapped_column(Integer,default=1)
    sealed_payload:Mapped[str]=mapped_column(Text)

    def binding(self):
        return FederatedBinding(self.institution_id,self.__tablename__,str(self.id),data_version=self.version)

    def put(self,value):
        self.sealed_payload=seal(value,self.binding())

    def read(self):
        return open_sealed(self.sealed_payload,self.binding())


class FederatedProject(BoundObject,Base):
    __tablename__='federated_projects'
    id:Mapped[int]=mapped_column(ForeignKey('research_projects.id'),primary_key=True,autoincrement=False)
    owner_user_id:Mapped[int]=mapped_column(ForeignKey('users.id'),index=True)
    client_request_id:Mapped[str]=mapped_column(String(64),unique=True)


class FederatedProjectMember(BoundObject,Base):
    __tablename__='federated_project_members'
    id:Mapped[int]=mapped_column(ForeignKey('research_project_members.id'),primary_key=True,autoincrement=False)
    project_id:Mapped[int]=mapped_column(ForeignKey('federated_projects.id'),index=True)
    user_id:Mapped[int]=mapped_column(ForeignKey('users.id'),index=True)


class FederatedNode(BoundObject,AuthorityMixin,Base):
    __tablename__='federated_nodes'
    id:Mapped[str]=mapped_column(String(64),primary_key=True,default=lambda:uuid4().hex)
    public_key_fingerprint:Mapped[str]=mapped_column(String(64),unique=True)
    registered_by:Mapped[int]=mapped_column(ForeignKey('users.id'))


class FederatedProjectNode(BoundObject,Base):
    __tablename__='federated_project_nodes'
    __table_args__=(UniqueConstraint('project_id','node_id',name='uq_federated_project_node'),)
    id:Mapped[str]=mapped_column(String(64),primary_key=True)
    project_id:Mapped[int]=mapped_column(ForeignKey('federated_projects.id'),index=True)
    node_id:Mapped[str]=mapped_column(ForeignKey('federated_nodes.id'),index=True)


class FederatedAuditHead(BoundObject,Base):
    __tablename__='federated_audit_heads'
    id:Mapped[str]=mapped_column(String(64),primary_key=True)
    ledger_key:Mapped[str]=mapped_column(String(64),unique=True)
    revision:Mapped[int]=mapped_column(Integer)


class FederatedConsentReceipt(BoundObject,Base):
    """Immutable operation receipt; the referenced unified consent remains authoritative."""
    __tablename__='federated_consent_receipts'
    id:Mapped[str]=mapped_column(String(64),primary_key=True)
    project_id:Mapped[int]=mapped_column(ForeignKey('federated_projects.id'),index=True)
    patient_id:Mapped[int]=mapped_column(ForeignKey('patients.id'),index=True)
    consent_id:Mapped[int]=mapped_column(ForeignKey('consent_records.id'),index=True)


class FederatedConsentBinding(BoundObject,Base):
    """Only original grant context; current consent status lives in ConsentRecord."""
    __tablename__='federated_consent_bindings'
    id:Mapped[int]=mapped_column(ForeignKey('consent_records.id'),primary_key=True,autoincrement=False)
    project_id:Mapped[int]=mapped_column(ForeignKey('federated_projects.id'),index=True)


class FederatedNodeRuntime(BoundObject,Base):
    __tablename__='federated_node_runtime'
    id:Mapped[str]=mapped_column(ForeignKey('federated_nodes.id'),primary_key=True)


class FederatedAuditEvent(BoundObject,Base):
    __tablename__='federated_audit_events'
    __table_args__=(UniqueConstraint('institution_id','sequence',name='uq_federated_audit_sequence'),)
    id:Mapped[str]=mapped_column(String(64),primary_key=True)
    sequence:Mapped[int]=mapped_column(Integer)
    actor_user_id:Mapped[int|None]=mapped_column(ForeignKey('users.id'),index=True,nullable=True)
    project_id:Mapped[int|None]=mapped_column(ForeignKey('federated_projects.id'),nullable=True,index=True)
    client_request_id:Mapped[str]=mapped_column(String(64),unique=True)
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=lambda:datetime.now(timezone.utc))


def immutable(*_):
    raise ValueError('Federated audit events are append-only.')


event.listen(FederatedAuditEvent,'before_update',immutable)
event.listen(FederatedAuditEvent,'before_delete',immutable)
event.listen(FederatedConsentReceipt,'before_update',immutable)
event.listen(FederatedConsentReceipt,'before_delete',immutable)
event.listen(FederatedConsentBinding,'before_update',immutable)
event.listen(FederatedConsentBinding,'before_delete',immutable)
