"""Job-queue tasks (Procrastinate). Plain job queue — explicitly NOT an
agent runtime (Hard Requirement #13).

Queues:
  cpu_heavy — whisper transcription; concurrency 1 so we never take more
              than 2 cores from bitcoind/LND.
  default   — LLM parsing, imports, backups.
"""
from __future__ import annotations

from ..config import settings
from ..db import job_app, session as db_session


@job_app.task(queue="cpu_heavy", name="transcribe_capture")
def transcribe_capture(capture_id: str) -> None:
    import uuid

    from ..capture import pipeline

    with db_session() as s:
        pipeline.run_transcription(s, uuid.UUID(capture_id), settings.data_dir)
    parse_capture.defer(capture_id=capture_id)


@job_app.task(queue="default", name="parse_capture")
def parse_capture(capture_id: str) -> None:
    import uuid

    from ..capture import pipeline

    with db_session() as s:
        pipeline.run_parse(s, uuid.UUID(capture_id))


@job_app.task(queue="default", name="route_capture")
def route_capture(capture_id: str) -> None:
    import uuid

    from ..capture import pipeline

    with db_session() as s:
        pipeline.run_route(s, uuid.UUID(capture_id))


@job_app.task(queue="default", name="attach_weather")
def attach_weather_task(operation_id: str) -> bool:
    import uuid

    from ..services import weather

    with db_session() as s:
        ok = weather.attach_weather(s, uuid.UUID(operation_id))
        s.commit()
        return ok


@job_app.task(queue="default", name="run_backup")
def run_backup_task() -> dict:
    from ..services import backup

    return backup.run_backup()
