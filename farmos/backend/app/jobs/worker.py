"""Worker entrypoint: `python -m app.jobs.worker`.

Single-concurrency worker: guarantees whisper single-flight (never two
transcriptions competing with bitcoind) and is plenty for one farm's job
volume. If parse latency behind long transcriptions ever matters, split
into two worker processes (default vs cpu_heavy) — do NOT raise
concurrency on a worker that serves cpu_heavy.
"""
from __future__ import annotations

from ..db import job_app


def main() -> None:
    with job_app.open():
        job_app.run_worker(queues=["default", "cpu_heavy"], concurrency=1)


if __name__ == "__main__":
    main()
