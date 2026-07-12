"""Load a tax-form line-map pack (file-based, no database).

Unlike region packs, tax packs are a small static lookup used only at
report time, so they live entirely in memory — no tables, no migration.
`load_schedule_f(year)` returns the pack whose tax_year best fits the
requested year (latest tax_year <= year, else the earliest available),
with a normalized category index for classification.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml

from .schema import TaxFormPack

PACKS_DIR = Path(__file__).parent / "packs"


def _normalize(category: str) -> str:
    return category.strip().lower().replace("-", "_").replace(" ", "_")


@dataclass(frozen=True)
class LineHit:
    line: str
    name: str


class ScheduleFMap:
    """A loaded Schedule F pack plus a category -> line index per section."""

    def __init__(self, pack: TaxFormPack):
        self.pack = pack
        self._income: dict[str, LineHit] = {}
        self._expense: dict[str, LineHit] = {}
        for tl in pack.income_lines:
            for cat in tl.categories:
                self._income[_normalize(cat)] = LineHit(tl.line, tl.name)
        for tl in pack.expense_lines:
            for cat in tl.categories:
                self._expense[_normalize(cat)] = LineHit(tl.line, tl.name)

    def classify(self, kind: str, category: str | None) -> LineHit | None:
        """Map a transaction (kind + category) to a Schedule F line, or None.

        The literal category "other" is treated as unclassified so it lands
        in the uncategorized gap rather than IRS line 32.
        """
        if not category:
            return None
        key = _normalize(category)
        if key in ("", "other"):
            return None
        index = self._income if kind == "income" else self._expense
        return index.get(key)

    def line_order(self) -> list[tuple[str, str, str]]:
        """(section, line, name) in form order — for stable report output."""
        rows = [("income", tl.line, tl.name) for tl in self.pack.income_lines]
        rows += [("expense", tl.line, tl.name) for tl in self.pack.expense_lines]
        return rows


def _read_pack(path: Path) -> TaxFormPack:
    return TaxFormPack.model_validate(yaml.safe_load(path.read_bytes()))


@lru_cache(maxsize=1)
def _all_schedule_f_packs() -> tuple[TaxFormPack, ...]:
    packs = [_read_pack(p) for p in sorted(PACKS_DIR.glob("schedule-f-*.yaml"))]
    if not packs:
        raise FileNotFoundError("no schedule-f-*.yaml tax pack found")
    return tuple(sorted(packs, key=lambda p: p.tax_year))


def load_schedule_f(year: int | None = None) -> ScheduleFMap:
    """Best-fit pack for `year`: latest tax_year <= year, else the earliest."""
    packs = _all_schedule_f_packs()
    if year is None:
        return ScheduleFMap(packs[-1])
    eligible = [p for p in packs if p.tax_year <= year]
    chosen = eligible[-1] if eligible else packs[0]  # packs sorted ascending by tax_year
    return ScheduleFMap(chosen)
