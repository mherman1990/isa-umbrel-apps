# Farm OS database image: PostGIS + pgvector, multi-arch.
# Memory tuning lives in the compose `command:` flags so it's visible and
# editable without rebuilding the image (the Pi shares RAM with a Bitcoin
# node — small buffers are a feature).
FROM postgis/postgis:16-3.4
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-16-pgvector && rm -rf /var/lib/apt/lists/*
