"""Resume durable Agent IDs; no provider or ordinary API worker runs here."""
from datetime import datetime,timezone
from logging import getLogger
from threading import Event,Thread
from sqlalchemy import select,or_,and_
from backend.app.models.agent import AgentRun
from backend.app.db.agent_migration import require_agent_schema
from backend.app.services.agent.runner import schedule_run


def scan_once(session_factory, *, limit=32, stop_event=None):
    if type(limit) is not int or not 1 <= limit <= 64:
        raise ValueError('Agent recovery scan must be bounded to 1..64 original IDs.')
    with session_factory() as db:
        require_agent_schema(db.connection())
        ids=db.scalars(select(AgentRun.id).where(or_(AgentRun.status=='queued',and_(AgentRun.status=='running',
            or_(AgentRun.lease_expires_at <= datetime.now(timezone.utc),AgentRun.lease_expires_at.is_(None)))))
            .order_by(AgentRun.id).limit(limit)).all()
    count=0
    for identifier in ids:
        if stop_event is not None and stop_event.is_set():
            break
        if schedule_run(session_factory,identifier):
            count+=1
    return count


class AgentWorkerRuntime:
    def __init__(self,session_factory,*,interval_seconds=2):
        if not .1 <= interval_seconds <= 60:
            raise ValueError('Agent recovery interval is outside the supported range.')
        self.factory=session_factory; self.interval=interval_seconds; self.stop_event=Event(); self.thread=None

    def _loop(self):
        last_error=None
        while not self.stop_event.is_set():
            try:
                scan_once(self.factory,stop_event=self.stop_event); last_error=None
            except Exception as exc:
                if type(exc).__name__ != last_error:
                    getLogger('agent.worker').warning('Agent recovery scan paused (%s); durable originals are retained.',type(exc).__name__)
                last_error=type(exc).__name__
            self.stop_event.wait(self.interval)

    def start(self):
        if self.thread is not None and self.thread.is_alive():
            return False
        self.stop_event.clear(); self.thread=Thread(target=self._loop,name='unified-agent-recovery',daemon=True); self.thread.start()
        return True

    def stop(self,timeout=5):
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=timeout)
        return self.thread is None or not self.thread.is_alive()
