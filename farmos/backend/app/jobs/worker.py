"""Worker entrypoint: `python -m app.jobs.worker`.

Single-concurrency worker: guarantees whisper single-flight (never two
transcriptions competing with bitcoind) and is plenty for one farm's job
volume. If parse latency behind long transcriptions ever matters, split
into two worker processes (default vs cpu_heavy) — do NOT raise
concurrency on a worker that serves cpu_heavy.
"""
from __future__ import annotations

import procrastinate

from ..db import _psycopg_dsn, job_app


def main() -> None:
    # The app is defined with a sync connector (right for the web process);
    # the worker loop is async and needs the async connector swapped in.
    async_connector = procrastinate.PsycopgConnector(conninfo=_psycopg_dsn())
    with job_app.replace_connector(async_connector):
        job_app.run_worker(queues=["default", "cpu_heavy"], concurrency=1)


if __name__ == "__main__":
    main()
