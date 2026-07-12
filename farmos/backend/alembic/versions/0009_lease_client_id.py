"""Lease.client_id (offline idempotency) — Lease becomes client-creatable.

Revision ID: 0009
Revises: 0008
Create Date: 2026-07-12
"""
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # IF NOT EXISTS: on a fresh DB the 0001 baseline already built this column
    # (and its unique index, named lease_client_id_key by the metadata's
    # unique=True) from current model metadata. Idempotent for both paths.
    op.execute("ALTER TABLE lease ADD COLUMN IF NOT EXISTS client_id UUID")
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS lease_client_id_key ON lease (client_id)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS lease_client_id_key")
    op.drop_column("lease", "client_id")
