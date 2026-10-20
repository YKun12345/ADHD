"""Bounded polling outside requests, with an explicit stop and no external sends."""
import logging
from time import monotonic
from threading import Event, Thread

from backend.app.services.care_consumers import consumer_handlers
from backend.app.workers.care_worker import run_once

logger = logging.getLogger("care.worker")


class CareWorkerRuntime:
    def __init__(self,session_factory,*,interval_seconds=1,lease_seconds=30,batch_size=16):
        if not 0.1 <= interval_seconds <= 60 or not 1 <= lease_seconds <= 3600 or not 1 <= batch_size <= 64:
            raise ValueError("Care worker polling limits are outside the supported bounds.")
        self.session_factory = session_factory
        self.interval_seconds = interval_seconds
        self.lease_seconds = lease_seconds
        self.batch_size = batch_size
        # SQLite has one writer. A maintenance batch locks it before checking
        # originals; keep that transaction to one item so API audits can commit
        # between polls. Durable cursors still advance and all stages still run.
        with session_factory() as db:
            self._maintenance_limit = 1 if db.get_bind().dialect.name == 'sqlite' else batch_size
        self._stop = Event()
        self._thread = None
        self._next_reconciliation = 0

    @property
    def running(self):
        return self._thread is not None and self._thread.is_alive()

    def start(self):
        if self.running:
            return
        self._stop.clear()
        self._next_reconciliation = 0
        self._thread = Thread(target=self._run,name="care-outbox",daemon=True)
        self._thread.start()

    def _run(self):
        while not self._stop.is_set():
            try:
                handlers = consumer_handlers()
                for _ in range(self.batch_size):
                    if self._stop.is_set() or not run_once(self.session_factory,handlers,lease_seconds=self.lease_seconds):
                        break
                if not self._stop.is_set() and monotonic() >= self._next_reconciliation:
                    from backend.app.services.care_authority_reconciliation import reconcile_once
                    reconcile_once(self.session_factory, limit=self._maintenance_limit, can_continue=lambda: not self._stop.is_set())
                    if not self._stop.is_set():
                        from backend.app.services.attention_deadline_service import monitor_once
                        monitor_once(self.session_factory, limit=self._maintenance_limit, can_continue=lambda: not self._stop.is_set())
                    if not self._stop.is_set():
                        from backend.app.services.care_transfer_maintenance import maintain_once
                        maintain_once(self.session_factory, limit=self._maintenance_limit, can_continue=lambda: not self._stop.is_set())
                    self._next_reconciliation = monotonic() + max(1, self.interval_seconds)
            except Exception as exc:
                # Health payloads and exception messages must not enter logs.
                logger.warning("Care worker polling paused (%s).",type(exc).__name__)
            self._stop.wait(self.interval_seconds)

    def stop(self,timeout=5):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
        return not self.running


if __name__ == "__main__":
    from backend.app.core.config import settings
    from backend.app.db.init_db import init_db
    from backend.app.db.session import SessionLocal
    if not settings.CARE_WORKER_ENABLED:
        raise SystemExit("Enable CARE_WORKER_ENABLED explicitly after schema review.")
    init_db()
    runtime = CareWorkerRuntime(SessionLocal,interval_seconds=settings.CARE_WORKER_INTERVAL_SECONDS,
        lease_seconds=settings.CARE_WORKER_LEASE_SECONDS)
    runtime.start()
    try:
        while runtime.running:
            runtime._stop.wait(1)
    except KeyboardInterrupt:
        pass
    finally:
        if not runtime.stop():
            logger.error("Care worker is still finishing an active transaction after the shutdown wait.")
