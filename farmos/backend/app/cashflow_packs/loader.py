"""Load a cash-flow timing pack (file-based, no database)."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml

from .schema import CashflowPack

PACKS_DIR = Path(__file__).parent / "packs"

# Even 1/12 spread for categories the pack does not list.
_EVEN = {m: round(1 / 12, 6) for m in range(1, 13)}


def _normalize(category: str) -> str:
    return category.strip().lower().replace("-", "_").replace(" ", "_")


class CashflowTiming:
    def __init__(self, pack: CashflowPack):
        self.pack = pack
        self._by_cat = {_normalize(k): v for k, v in pack.expense_timing.items()}

    def weights(self, category: str | None) -> tuple[dict[int, float], bool]:
        """(month -> weight, is_even_fallback). Unknown/empty -> even spread."""
        if category:
            hit = self._by_cat.get(_normalize(category))
            if hit:
                return hit, False
        return _EVEN, True


@lru_cache(maxsize=1)
def _all_packs() -> tuple[CashflowPack, ...]:
    packs = [CashflowPack.model_validate(yaml.safe_load(p.read_bytes())) for p in sorted(PACKS_DIR.glob("*.yaml"))]
    if not packs:
        raise FileNotFoundError("no cash-flow timing pack found")
    return tuple(sorted(packs, key=lambda p: p.version))


def load_cashflow_timing() -> CashflowTiming:
    """Latest available timing pack (single region for now)."""
    return CashflowTiming(_all_packs()[-1])
