"""Grain contracts (position ledger input).

Revision ID: 0006
Revises: 0005
Create Date: 2026-07-12
"""
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    from app.models import Base

    Base.metadata.create_all(bind=op.get_bind(), tables=[Base.metadata.tables["grain_contract"]])


def downgrade() -> None:
    op.drop_table("grain_contract")
