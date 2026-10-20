"""Finish aggregate reads before taking SQLite's writer for their critical audits."""
from copy import deepcopy
from functools import wraps

from fastapi import HTTPException

_QUEUE = 'deferred_read_audit_queue'


def append_read_audit(db, *, failure_detail, **values):
    queue = db.info.get(_QUEUE)
    if queue is not None:
        queue.append((deepcopy(values), failure_detail))
        return
    from backend.app.services.security_service import _append_audit_log
    return _append_audit_log(db, **values)


def finish_reads_before_audits(operation):
    @wraps(operation)
    def collect(db, *args, **kwargs):
        if _QUEUE in db.info:
            return operation(db, *args, **kwargs)
        queue = []
        db.info[_QUEUE] = queue
        try:
            result = operation(db, *args, **kwargs)
        finally:
            db.info.pop(_QUEUE, None)
        # Same order, content, session and transaction. No response is returned
        # until every audit is written; the caller still commits and rechecks.
        from backend.app.services.security_service import _append_audit_log
        for values, failure_detail in queue:
            try:
                _append_audit_log(db, **values)
            except HTTPException:
                raise
            except Exception as exc:
                raise HTTPException(503, failure_detail) from exc
        return result
    return collect
