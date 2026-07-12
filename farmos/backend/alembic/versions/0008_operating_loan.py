"""Operating loan + event ledger (cash-flow / operating-line tracking).

Revision ID: 0008
Revises: 0007
Create Date: 2026-07-12
"""
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

NEW_TABLES = ["operating_loan", "operating_loan_event"]


def upgrade() -> None:
    # create_all is IF-NOT-EXISTS by nature, so this stays safe on a fresh DB
    # where the 0001 baseline already built these from current metadata.
    from app.models import Base

    tables = [Base.metadata.tables[name] for name in NEW_TABLES]
    Base.metadata.create_all(bind=op.get_bind(), tables=tables)


def downgrade() -> None:
    for name in reversed(NEW_TABLES):
        op.drop_table(name)
