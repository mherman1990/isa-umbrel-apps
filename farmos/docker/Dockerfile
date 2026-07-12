# Farm OS app image — multi-arch (linux/arm64 + linux/amd64).
# Stage 1: PWA build. Stage 2: whisper.cpp build + model download.
# Stage 3: slim Python runtime serving API + static PWA; same image runs
# the worker (CMD ["worker"]).

FROM node:22-slim AS frontend
WORKDIR /fe
COPY farmos/frontend/package.json farmos/frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY farmos/frontend/ ./
RUN npm run build

FROM debian:bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /w
# Pinned release so builds are reproducible.
RUN git clone --depth 1 --branch v1.7.4 https://github.com/ggml-org/whisper.cpp.git
# GGML_NATIVE=OFF: never bake the build host's -march=native into an image that
#   ships to a Cortex-A76 Pi (would risk SIGILL), and it's the flag that breaks
#   the ggml compile under QEMU-emulated arm64.
# -j2 (not $(nproc)): emulated g++ on the big ggml sources OOM-kills at -j4 on a
#   hosted runner, which surfaces as a bare `exit code: 2`.
# tests/server off so only the whisper-cli dependency graph compiles.
RUN cmake -S whisper.cpp -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=OFF \
      -DWHISPER_BUILD_TESTS=OFF \
      -DWHISPER_BUILD_SERVER=OFF \
      -DWHISPER_BUILD_EXAMPLES=ON \
    && cmake --build build -j2 --target whisper-cli
RUN mkdir -p /opt/whisper \
    && curl -fL -o /opt/whisper/ggml-base.en.bin \
       https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg restic postgresql-client libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY farmos/backend/pyproject.toml ./backend/pyproject.toml
COPY farmos/backend/app ./backend/app
COPY farmos/backend/alembic ./backend/alembic
COPY farmos/backend/alembic.ini ./backend/alembic.ini
RUN pip install --no-cache-dir ./backend

COPY --from=whisper /w/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /opt/whisper /opt/whisper
COPY --from=frontend /fe/dist ./backend/static
COPY farmos/scripts/farmos-restore /usr/local/bin/farmos-restore
COPY farmos/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/farmos-restore

ENV FARMOS_DATA_DIR=/data \
    PYTHONUNBUFFERED=1
WORKDIR /srv/backend
EXPOSE 8585
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s \
    CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8585/healthz', timeout=5)" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["web"]
