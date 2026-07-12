"""Management commands: `python -m app.manage <command>`.

  load-pack            Load the newest bundled region pack (idempotent).
  procrastinate-schema Apply the job-queue schema (idempotent).
"""
from __future__ import annotations

import sys


def load_pack() -> None:
    from .db import session
    from .region_packs import loader

    path = loader.default_pack_path()
    if path is None:
        print("no region packs bundled")
        return
    with session() as s:
        row = loader.load_pack(s, path)
        s.commit()
        print(f"region pack {row.region_code} {row.version} loaded")


def procrastinate_schema() -> None:
    from .db import job_app

    with job_app.open():
        job_app.schema_manager.apply_schema()
    print("procrastinate schema applied")


def seed_demo() -> None:
    from .db import session
    from .seed_demo import seed

    with session() as s:
        result = seed(s)
        s.commit()
    if result.get("owner_token"):
        print(f"demo farm seeded ({result['fields']} fields)")
        print(f"owner bearer token (sandbox only): {result['owner_token']}")
    else:
        print(result.get("note", "done"))


COMMANDS = {"load-pack": load_pack, "procrastinate-schema": procrastinate_schema, "seed-demo": seed_demo}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(f"usage: python -m app.manage [{'|'.join(COMMANDS)}]", file=sys.stderr)
        raise SystemExit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
