"""restic backup wrapper.

Nightly (02:30) snapshot of: a fresh pg_dump, the artifact store, secrets
and config — client-side encrypted with a key generated on this box. The
key is rendered ONCE in the UI as a recovery phrase; without it, off-box
backups are unrecoverable by design ("farm data stays on the farm" is not
a suicide pact — the ciphertext can live anywhere).
"""
from __future__ import annotations

import json
import secrets
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from ..config import settings

# 2048-word BIP39-style list is overkill for a restic password; we render
# the 32-byte key as 8 groups of 4 hex chars, which farmers can write down.


def _key_path() -> Path:
    return settings.secrets_dir / "restic_key"


def ensure_key() -> tuple[str, bool]:
    """Returns (recovery_phrase, created_now)."""
    p = _key_path()
    if p.exists():
        return p.read_text().strip(), False
    settings.secrets_dir.mkdir(parents=True, exist_ok=True)
    phrase = "-".join(secrets.token_hex(2) for _ in range(8))
    p.write_text(phrase + "\n")
    p.chmod(0o600)
    return phrase, True


def _repos() -> list[str]:
    cfg = settings.data_dir / "config" / "backup.json"
    if not cfg.exists():
        return []
    return json.loads(cfg.read_text()).get("repos", [])


def set_repos(repos: list[str], env: dict | None = None) -> None:
    cfg_dir = settings.data_dir / "config"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "backup.json").write_text(json.dumps({"repos": repos, "env": env or {}}, indent=2))


def _restic(repo: str, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    import os

    env = dict(os.environ)
    env["RESTIC_REPOSITORY"] = repo
    env["RESTIC_PASSWORD_FILE"] = str(_key_path())
    cfg = settings.data_dir / "config" / "backup.json"
    if cfg.exists():
        env.update(json.loads(cfg.read_text()).get("env", {}))  # e.g. AWS_ACCESS_KEY_ID for S3 repos
    return subprocess.run(["restic", *args], env=env, capture_output=True, text=True, check=check, timeout=3600)


def _pg_dump() -> Path:
    staging = settings.backup_staging_dir
    staging.mkdir(parents=True, exist_ok=True)
    out = staging / "farmos.dump"
    dsn = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    subprocess.run(["pg_dump", "-Fc", "-f", str(out), dsn], check=True, capture_output=True, timeout=1800)
    return out


def run_backup() -> dict:
    ensure_key()
    repos = _repos()
    if not repos:
        return {"ok": False, "error": "no backup destination configured"}
    dump = _pg_dump()
    paths = [str(dump), str(settings.artifacts_dir), str(settings.secrets_dir), str(settings.data_dir / "config")]
    results = {}
    for repo in repos:
        try:
            _restic(repo, "snapshots", check=True)
        except subprocess.CalledProcessError:
            _restic(repo, "init")
        _restic(repo, "backup", "--exclude", str(_key_path()), *[p for p in paths if Path(p).exists()])
        _restic(repo, "forget", "--keep-daily", "14", "--keep-weekly", "8", "--keep-monthly", "12", "--prune")
        results[repo] = "ok"
    _status_write({"last_backup_at": datetime.now(timezone.utc).isoformat(), "repos": results})
    return {"ok": True, "repos": results}


def _status_path() -> Path:
    return settings.data_dir / "config" / "backup_status.json"


def _status_write(status: dict) -> None:
    _status_path().parent.mkdir(parents=True, exist_ok=True)
    _status_path().write_text(json.dumps(status, indent=2))


def status() -> dict:
    base = {"configured": bool(_repos()), "repos": _repos(), "last_backup_at": None, "age_hours": None}
    if _status_path().exists():
        saved = json.loads(_status_path().read_text())
        base["last_backup_at"] = saved.get("last_backup_at")
        if base["last_backup_at"]:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(base["last_backup_at"])
            base["age_hours"] = round(age.total_seconds() / 3600, 1)
    return base
