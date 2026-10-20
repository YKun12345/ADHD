"""Transactional care outbox engine.

Handlers are a fixed server-owned mapping. A handler must only write through the
provided session, must not commit or perform external I/O, and must use a durable
business unique key. Return None for success, or 'suspended' for a committed
permanent business pause. This engine never imports a user-provided handler.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from collections.abc import Mapping
from secrets import token_hex

from sqlalchemy import and_, or_, select, update, event as session_events

from backend.app.models.event import CareEvent, CareEventDelivery


@dataclass(frozen=True)
class Claim:
    delivery_id: int
    event_id: str
    consumer: str
    lease_token: str
    lease_expires_at: datetime


class LeaseLost(Exception):
    """The transaction must roll back because its claim no longer owns a lease."""


def _utc(value=None):
    value = datetime.now(timezone.utc) if value is None else value
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _registry(handlers):
    if not isinstance(handlers, Mapping):
        raise TypeError("Handlers must be a server-owned mapping")
    registered = dict(handlers)
    if any(not isinstance(name, str) or not name or len(name) > 64 or not callable(handler)
           for name, handler in registered.items()):
        raise ValueError("Invalid registered consumer")
    return registered


def _eligible(now):
    delivery = CareEventDelivery
    return or_(
        delivery.status == "pending",
        and_(delivery.status == "retry_failed",
             or_(delivery.next_attempt_at.is_(None), delivery.next_attempt_at <= now)),
        and_(delivery.status == "processing", delivery.lease_expires_at <= now),
    )


def claim_next(session_factory, handlers, now=None, lease_seconds=30):
    """Claim at most one eligible registered delivery using database CAS.

    A bounded candidate list tolerates competition without an implicit drain or
    unbounded contention loop. A lost CAS simply leaves work for a later call.
    """
    registered = _registry(handlers)
    if not registered:
        return None
    if isinstance(lease_seconds, bool) or not isinstance(lease_seconds, (int, float)) or not 0 < lease_seconds <= 3600:
        raise ValueError("lease_seconds must be in (0, 3600]")
    now = _utc(now)
    deadline = now + timedelta(seconds=lease_seconds)
    delivery = CareEventDelivery
    with session_factory() as db:
        with db.begin():
            candidates = db.execute(select(delivery.id, delivery.event_id, delivery.consumer)
                .where(delivery.consumer.in_(registered), _eligible(now))
                .order_by(delivery.id).limit(32)).all()
            for row in candidates:
                token = token_hex(32)
                result = db.execute(update(delivery).where(delivery.id == row.id,
                    delivery.event_id == row.event_id, delivery.consumer == row.consumer,
                    _eligible(now)).values(status="processing", lease_token=token,
                    lease_expires_at=deadline, attempts=delivery.attempts + 1,
                    next_attempt_at=None, completed_at=None).execution_options(synchronize_session=False))
                if result.rowcount == 1:
                    claim = Claim(row.id, row.event_id, row.consumer, token, deadline)
                    break
            else:
                claim = None
        return claim


def _owned(claim, now):
    delivery = CareEventDelivery
    return and_(delivery.id == claim.delivery_id, delivery.event_id == claim.event_id,
        delivery.consumer == claim.consumer, delivery.status == "processing",
        delivery.lease_token == claim.lease_token, delivery.lease_expires_at > now)


def _install_authority_guards(db, clock, deadline):
    # Worker sessions do not pass through the HTTP get_db dependency. Evaluate
    # the dynamic receipt set on each flush and commit, including receipts
    # introduced by the handler after this session was created.
    def recheck(*_):
        if (db.info.get("authorization_receipts") or db.info.get("credential_receipts")
                or db.info.get("authenticated_actor_id") is not None):
            from backend.app.services.identity_access import recheck_request_authority
            recheck_request_authority(db)
    def before_commit(*_):
        recheck()
        # A fresh-session authority check can itself take time. It must not
        # consume the lease and then allow the surrounding transaction to commit.
        if clock() >= _utc(deadline):
            raise LeaseLost()
    session_events.listen(db, "before_flush", recheck)
    session_events.listen(db, "before_commit", before_commit)


def _mark_retry(session_factory, claim, now, error):
    delivery = CareEventDelivery
    with session_factory() as db:
        with db.begin():
            # This conditional write also acquires the database lock. An expired
            # or replaced claim cannot overwrite another worker's current state.
            owned = db.execute(update(delivery).where(_owned(claim, now))
                .values(lease_token=claim.lease_token).execution_options(synchronize_session=False))
            if owned.rowcount != 1:
                return
            attempts = db.scalar(select(delivery.attempts).where(delivery.id == claim.delivery_id))
            delay = min(300, 2 ** min(max(attempts - 1, 0), 9))
            # Exception message, repr, payload and stack never enter the ledger.
            db.execute(update(delivery).where(_owned(claim, now)).values(
                status="retry_failed", last_error=type(error).__name__[:256],
                next_attempt_at=now + timedelta(seconds=delay), lease_token=None,
                lease_expires_at=None).execution_options(synchronize_session=False))


def process_claim(session_factory, claim, handlers, clock=None):
    """Commit handler output, critical audit and terminal ACK atomically.

    False means no terminal result was committed by this call. An interrupted
    process needs no cleanup: its uncommitted work rolls back and its persisted
    claim becomes eligible after the lease deadline.
    """
    registered = _registry(handlers)
    if claim is None or claim.consumer not in registered:
        return False
    current_time = (lambda: _utc(clock())) if clock is not None else _utc
    delivery = CareEventDelivery
    try:
        with session_factory() as db:
            with db.begin():
                started = current_time()
                locked = db.execute(update(delivery).where(_owned(claim, started))
                    .values(lease_token=claim.lease_token).execution_options(synchronize_session=False))
                if locked.rowcount != 1:
                    raise LeaseLost()
                deadline = db.scalar(select(delivery.lease_expires_at)
                    .where(delivery.id == claim.delivery_id).with_for_update())
                _install_authority_guards(db, current_time, deadline)
                # Lock the aggregate event so sibling consumers serialize their
                # final publication check on databases with per-row locking.
                event = db.scalar(select(CareEvent).where(CareEvent.event_id == claim.event_id)
                    .with_for_update())
                if event is None:
                    raise ValueError("Claim source event is unavailable")
                result = registered[claim.consumer](db, event, started)
                if result is None:
                    terminal = "succeeded"
                elif type(result) is str and result == "suspended":
                    terminal = "suspended"
                else:
                    raise ValueError("Invalid consumer outcome")
                from backend.app.services.security_service import _append_audit_log
                _append_audit_log(db, action="care_event_consumed", status=terminal,
                    message="Care consumer transaction completed.", patient_id=event.patient_id,
                    actor_user_id=event.actor_user_id, detail_json={"event_id": claim.event_id,
                        "delivery_id": claim.delivery_id, "consumer": claim.consumer,
                        "aggregate_type": event.aggregate_type, "aggregate_id": event.aggregate_id,
                        "revision": event.revision})
                db.flush()
                completed = current_time()
                ack = db.execute(update(delivery).where(_owned(claim, completed)).values(
                    status=terminal, completed_at=completed, lease_token=None,
                    lease_expires_at=None, last_error=None, next_attempt_at=None)
                    .execution_options(synchronize_session=False))
                if ack.rowcount != 1:
                    raise LeaseLost()
                remaining = db.scalar(select(delivery.id).where(delivery.event_id == claim.event_id,
                    delivery.status != "succeeded").limit(1))
                if remaining is None:
                    event.published_at = completed
                db.flush()
                # Recheck after every output/audit/ACK/publication write, directly
                # before commit. SQLite datetime loads can be naive UTC.
                if current_time() >= _utc(deadline):
                    raise LeaseLost()
        return True
    except LeaseLost:
        return False
    except Exception as error:
        # The business transaction has already rolled back before this new one.
        _mark_retry(session_factory, claim, current_time(), error)
        return False


def run_once(session_factory, handlers, clock=None, lease_seconds=30):
    """Make one bounded claim-and-process attempt without sleeping or networking."""
    registered = _registry(handlers)
    now = None if clock is None else clock()
    claim = claim_next(session_factory, registered, now=now, lease_seconds=lease_seconds)
    if claim is None:
        return False
    return process_claim(session_factory, claim, registered, clock=clock)
