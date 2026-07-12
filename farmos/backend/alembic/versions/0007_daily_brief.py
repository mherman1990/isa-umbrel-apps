"""Daily brief.

Revision ID: 0007
Revises: 0006
Create Date: 2026-07-12
"""
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    from app.models import Base

    Base.metadata.create_all(bind=op.get_bind(), tables=[Base.metadata.tables["daily_brief"]])


def downgrade() -> None:
    op.drop_table("daily_brief")
