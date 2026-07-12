"""Evidence requirements (MRV readiness).

Revision ID: 0005
Revises: 0004
Create Date: 2026-07-12
"""
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    from app.models import Base

    Base.metadata.create_all(bind=op.get_bind(), tables=[Base.metadata.tables["evidence_requirement"]])


def downgrade() -> None:
    op.drop_table("evidence_requirement")
