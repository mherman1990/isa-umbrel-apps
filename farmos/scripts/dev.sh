#!/bin/sh
# Local dev: Postgres+PostGIS in Docker, API with reload, Vite dev server.
#   ./scripts/dev.sh db      — start a dev database (docker)
#   ./scripts/dev.sh api     — run the API with reload (needs the db)
#   ./scripts/dev.sh worker  — run the job worker
#   ./scripts/dev.sh web     — run the Vite dev server (proxies /api to :8585)
set -e
cd "$(dirname "$0")/.."

export FARMOS_DATABASE_URL="${FARMOS_DATABASE_URL:-postgresql+psycopg://farmos:farmos@localhost:5433/farmos}"
export FARMOS_DATA_DIR="${FARMOS_DATA_DIR:-/tmp/farmos-dev-data}"

case "${1:-help}" in
  db)
    docker run --rm -d --name farmos-dev-db -p 5433:5432 \
      -e POSTGRES_USER=farmos -e POSTGRES_PASSWORD=farmos -e POSTGRES_DB=farmos \
      postgis/postgis:16-3.4
    echo "dev db on :5433"
    ;;
  api)
    cd backend
    python -m alembic upgrade head
    python -m app.manage procrastinate-schema
    python -m app.manage load-pack
    exec uvicorn app.main:app --reload --port 8585
    ;;
  worker)
    cd backend && exec python -m app.jobs.worker
    ;;
  web)
    cd frontend && exec npm run dev
    ;;
  *)
    grep '^#   ' "$0" | sed 's/^#   //'
    ;;
esac
