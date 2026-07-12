# Farm OS database image — PostGIS on a genuinely multi-arch base.
#
# We used to base on postgis/postgis:16-3.4, but that tag is not arm64-safe:
# on the Raspberry Pi (arm64) its container died with "exec format error"
# (amd64 binaries on an arm64 host). The official `postgres:16` image IS
# multi-arch (real linux/arm64), so we install PostGIS from PGDG on top of
# it. pgvector is optional — it's only used for document embeddings later,
# and migration 0001 tolerates its absence — so its install is non-fatal.
FROM postgres:16-bookworm
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-16-postgis-3; \
    apt-get install -y --no-install-recommends postgresql-16-pgvector \
      || echo "pgvector unavailable for this architecture; skipping (optional)"; \
    rm -rf /var/lib/apt/lists/*
