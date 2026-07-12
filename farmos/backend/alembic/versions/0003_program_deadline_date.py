"""Machine-readable program deadline date (drives nudges).

Revision ID: 0003
Revises: 0002
Create Date: 2026-07-12
"""
import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # IF NOT EXISTS: the 0001 baseline creates tables from CURRENT model
    # metadata, so a fresh database already has this column when it reaches
    # this migration. Every ALTER-based migration in this repo must be
    # idempotent for that reason.
    op.execute("ALTER TABLE program ADD COLUMN IF NOT EXISTS signup_deadline_date DATE")


def downgrade() -> None:
    op.drop_column("program", "signup_deadline_date")
