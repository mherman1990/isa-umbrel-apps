"""Money (transactions, budget lines), soil tests, workbook mappings.

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-12
"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

NEW_TABLES = ["money_transaction", "budget_line", "soil_test", "workbook_mapping"]


def upgrade() -> None:
    from app.models import Base

    tables = [Base.metadata.tables[name] for name in NEW_TABLES]
    Base.metadata.create_all(bind=op.get_bind(), tables=tables)


def downgrade() -> None:
    for name in reversed(NEW_TABLES):
        op.drop_table(name)
