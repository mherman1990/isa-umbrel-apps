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
    op.add_column("program", sa.Column("signup_deadline_date", sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column("program", "signup_deadline_date")
