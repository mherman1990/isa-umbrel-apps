#!/usr/bin/env python3
"""The restore drill (Phase 1 acceptance + CI).

Seed → backup → wipe → restore → verify. If this doesn't pass, backups are
decorative. CI runs it against the PostGIS service container with a local
restic repo; on real hardware, run it against a USB stick.

  FARMOS_DATABASE_URL=... FARMOS_DATA_DIR=/tmp/drill python scripts/restore_drill.py
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))


def main() -> None:
    from sqlalchemy import create_engine, text

    from app.config import settings

    data_dir = settings.data_dir
    data_dir.mkdir(parents=True, exist_ok=True)
    engine = create_engine(settings.database_url)

    # -- seed ---------------------------------------------------------------
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], check=True, cwd=BACKEND)
    user_id = str(uuid.uuid4())
    capture_id = str(uuid.uuid4())
    artifact_rel = "artifacts/2026/07/drill.webm"
    artifact = data_dir / artifact_rel
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_bytes(b"drill-audio-" + os.urandom(64))
    artifact_sha = hashlib.sha256(artifact.read_bytes()).hexdigest()

    with engine.begin() as c:
        c.execute(text("DELETE FROM capture_event"))
        c.execute(text("DELETE FROM app_user"))
        c.execute(text("INSERT INTO app_user (id, display_name, role) VALUES (:id, 'Drill', 'owner')"), {"id": user_id})
        c.execute(
            text(
                "INSERT INTO capture_event (id, client_id, user_id, kind, artifact_path, artifact_sha256,"
                " mime_type, captured_at, status) VALUES (:id, :cid, :uid, 'voice', :path, :sha,"
                " 'audio/webm', now(), 'recorded')"
            ),
            {"id": capture_id, "cid": str(uuid.uuid4()), "uid": user_id, "path": artifact_rel, "sha": artifact_sha},
        )

    # -- backup -------------------------------------------------------------
    from app.services import backup

    with tempfile.TemporaryDirectory() as repo_dir:
        backup.ensure_key()
        backup.set_repos([repo_dir])
        result = backup.run_backup()
        assert result["ok"], result
        print(f"backup ok -> {repo_dir}")

        # -- wipe -------------------------------------------------------------
        artifact.unlink()
        with engine.begin() as c:
            c.execute(text("DELETE FROM capture_event"))
            c.execute(text("DELETE FROM app_user"))
        print("wiped: artifact deleted, rows deleted")

        # -- restore ----------------------------------------------------------
        key_file = settings.secrets_dir / "restic_key"
        subprocess.run(
            [
                sys.executable,
                str(Path(__file__).parent / "farmos-restore"),
                "--repo", repo_dir,
                "--password-file", str(key_file),
                "--yes",
            ],
            check=True,
        )

    # -- verify ---------------------------------------------------------------
    with engine.connect() as c:
        row = c.execute(
            text("SELECT artifact_sha256 FROM capture_event WHERE id = :id"), {"id": capture_id}
        ).fetchone()
    assert row is not None, "capture row did not survive restore"
    assert row[0] == artifact_sha, "capture sha mismatch after restore"
    restored = data_dir / artifact_rel
    assert restored.exists(), "artifact file did not survive restore"
    assert hashlib.sha256(restored.read_bytes()).hexdigest() == artifact_sha, "artifact bytes changed"
    print("\nRESTORE DRILL PASSED: rows and artifact bytes identical after wipe+restore")


if __name__ == "__main__":
    main()
