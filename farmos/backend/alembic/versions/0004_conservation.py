"""Conservation engine: practices, evidence, enrollments, stacking rules,
computable payment rates.

Revision ID: 0004
Revises: 0003
Create Date: 2026-07-12
"""
import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

NEW_TABLES = ["practice", "practice_evidence", "program_enrollment", "stacking_rule"]


def upgrade() -> None:
    from app.models import Base

    op.add_column("program", sa.Column("payment_per_acre", sa.Numeric(10, 2), nullable=True))
    tables = [Base.metadata.tables[name] for name in NEW_TABLES]
    Base.metadata.create_all(bind=op.get_bind(), tables=tables)


def downgrade() -> None:
    for name in reversed(NEW_TABLES):
        op.drop_table(name)
    op.drop_column("program", "payment_per_acre")
