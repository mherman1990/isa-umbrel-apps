#!/bin/sh
# Farm OS container entrypoint. `web` (default) serves the API+PWA;
# `worker` runs the job queue. Both wait for the DB and converge the
# schema first (alembic + procrastinate + region pack are all idempotent).
set -e

echo "waiting for database..."
python - <<'PY'
import sys, time
from sqlalchemy import create_engine, text
from app.config import settings

for attempt in range(60):
    try:
        with create_engine(settings.database_url).connect() as c:
            c.execute(text("SELECT 1"))
        sys.exit(0)
    except Exception:
        time.sleep(2)
print("database never came up", file=sys.stderr)
sys.exit(1)
PY

if [ "${1:-web}" = "web" ]; then
    python -m alembic upgrade head
    python -m app.manage procrastinate-schema
    python -m app.manage load-pack
    exec uvicorn app.main:app --host 0.0.0.0 --port "${FARMOS_PORT:-8585}"
elif [ "$1" = "worker" ]; then
    # web applies the schema; the worker just needs it present
    python - <<'PY'
import sys, time
from sqlalchemy import create_engine, text
from app.config import settings

for attempt in range(60):
    try:
        with create_engine(settings.database_url).connect() as c:
            c.execute(text("SELECT 1 FROM alembic_version"))
        sys.exit(0)
    except Exception:
        time.sleep(2)
print("schema never applied", file=sys.stderr)
sys.exit(1)
PY
    exec python -m app.jobs.worker
else
    exec "$@"
fi
