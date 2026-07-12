"""Cron-style periodic jobs."""
from __future__ import annotations

from ..db import job_app


@job_app.periodic(cron="30 2 * * *")
@job_app.task(queue="default", name="nightly_backup")
def nightly_backup(timestamp: int) -> dict:
    from ..services import backup

    return backup.run_backup()


@job_app.periodic(cron="0 3 * * *")
@job_app.task(queue="default", name="retry_parked_captures")
def retry_parked_captures(timestamp: int) -> int:
    """Captures parked on a spend-cap hit resume when the month rolls over
    (or the cap is raised)."""
    from sqlalchemy import select

    from ..db import session as db_session
    from ..models import CaptureEvent
    from .tasks import parse_capture, route_capture

    with db_session() as s:
        parked = s.scalars(
            select(CaptureEvent).where(CaptureEvent.status_detail == "spend_cap")
        ).all()
        for c in parked:
            if c.kind == "voice":
                parse_capture.defer(capture_id=str(c.id))
            else:
                route_capture.defer(capture_id=str(c.id))
        return len(parked)
