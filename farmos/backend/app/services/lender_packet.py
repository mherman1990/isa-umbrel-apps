"""Lender / operating-loan packet — assembled entirely from records.

A farm lender (FSA, Farm Credit, a local bank) wants an income statement,
enterprise detail, and grain position. We produce exactly what the records
support and say — plainly, up front — what we CANNOT produce (there is no
balance sheet because Farm OS holds no asset or debt records yet). Never a
fabricated figure; gaps are disclosed, not filled.

`build()` assembles the JSON; `render_html()` turns it into a single
self-contained, printer-friendly page (no external assets, no new deps —
the PWA prints it to PDF). Every dynamic string is HTML-escaped.
"""
from __future__ import annotations

import html
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import FarmProfile
from . import financials, grain

# What a full lender package would include but this data cannot yet support.
NOT_INCLUDED = [
    "Balance sheet (assets & liabilities) — Farm OS holds no asset or debt "
    "records, so net worth, working capital, and debt-to-asset ratios cannot "
    "be produced from this data.",
    "Depreciation schedules and Section 179 elections — see your tax preparer.",
    "Off-farm and non-farm income.",
    "Prior-year comparatives beyond what is recorded on this box.",
]


def build(session: Session, year: int) -> dict:
    profile = session.scalars(select(FarmProfile)).first()
    sf = financials.schedule_f(session, year)
    caveats = []
    if not sf["complete"] and (sf["uncategorized"]["income_total"] or sf["uncategorized"]["expense_total"]):
        caveats.append(
            "The income statement is INCOMPLETE: "
            f"${sf['uncategorized']['income_total'] + sf['uncategorized']['expense_total']:,.2f} of "
            "recorded money is uncategorized and excluded from the totals below."
        )
    return {
        "generated_for_year": year,
        "generated_on": date.today().isoformat(),
        "operation": {
            "name": (profile.operation_name if profile else None),
            "entity_type": (profile.entity_type if profile else None),
            "state": (profile.state_code if profile else None),
        },
        "basis": "Cash-basis farm records maintained in Farm OS; unaudited, prepared by the operator.",
        "income_statement": {
            "gross_farm_income": sf["totals"]["gross_income"],
            "total_expenses": sf["totals"]["total_expenses"],
            "net_farm_income": sf["totals"]["net_farm_profit"],
            "schedule_f": sf,
        },
        "budget_vs_actual": financials.crop_summary(session, year),
        "field_breakeven": financials.field_breakeven(session, year),
        "grain_position": grain.position(session, year),
        "caveats": caveats,
        "not_included": NOT_INCLUDED,
        "note": "Every figure is derived from records on this box. Missing pieces are named, never estimated.",
    }


# ----------------------------------------------------------------- HTML render


def _esc(value) -> str:
    return html.escape("" if value is None else str(value))


def _usd(x) -> str:
    return "—" if x is None else f"${float(x):,.2f}"


def _rows(pairs: list[tuple[str, str]]) -> str:
    return "".join(f"<tr><td>{k}</td><td class='num'>{v}</td></tr>" for k, v in pairs)


def render_html(packet: dict) -> str:
    op = packet["operation"]
    isr = packet["income_statement"]
    sf = isr["schedule_f"]

    sf_income = _rows([(f"Ln {_esc(l['line'])} — {_esc(l['name'])}", _usd(l["amount"])) for l in sf["income_lines"]])
    sf_expense = _rows([(f"Ln {_esc(l['line'])} — {_esc(l['name'])}", _usd(l["amount"])) for l in sf["expense_lines"]])

    uncat = sf["uncategorized"]["income"] + sf["uncategorized"]["expense"]
    uncat_html = ""
    if uncat:
        items = "".join(f"<li>“{_esc(u['category'])}”: {_usd(u['amount'])}</li>" for u in uncat)
        uncat_html = (
            "<div class='warn'><strong>Uncategorized (excluded from totals):</strong>"
            f"<ul>{items}</ul></div>"
        )

    bva_rows = "".join(
        f"<tr><td>{_esc(c['crop'])}</td><td class='num'>{c['acres'] or '—'}</td>"
        f"<td class='num'>{_usd(c['budget_total'])}</td><td class='num'>{_usd(c['actual_spend'])}</td>"
        f"<td class='num'>{_usd(c['income'])}</td></tr>"
        for c in packet["budget_vs_actual"]
    ) or "<tr><td colspan='5'>No crop budget/actual on record.</td></tr>"

    be_rows = "".join(
        f"<tr><td>{_esc(f['field_name'])} — {_esc(f['crop'])}</td>"
        f"<td class='num'>{f['acres']}</td>"
        f"<td class='num'>{_usd(f['allocated_costs'])}</td>"
        f"<td class='num'>{('%s bu' % format(f['harvested_bushels'], ',')) if f['harvested_bushels'] else '—'}</td>"
        f"<td class='num'>{('$%.2f/bu' % f['breakeven_per_bu']) if f['breakeven_per_bu'] is not None else _esc('; '.join(f['insufficient_data'] or []))}</td></tr>"
        for f in packet["field_breakeven"]
    ) or "<tr><td colspan='5'>No field cost/yield on record.</td></tr>"

    gp = packet["grain_position"]
    gp_rows = "".join(
        f"<tr><td>{_esc(c['crop'])}</td>"
        f"<td class='num'>{('%s' % format(c['produced_bu'], ',')) if c['produced_bu'] else '—'}</td>"
        f"<td class='num'>{('%s' % format(c['contracted_bu'], ','))}</td>"
        f"<td class='num'>{('%s' % format(c['priced_bu'], ','))}</td>"
        f"<td>{_esc('; '.join(c['gaps'] or []))}</td></tr>"
        for c in gp["crops"]
    ) or "<tr><td colspan='5'>No grain position on record.</td></tr>"

    caveats_html = ""
    if packet["caveats"]:
        caveats_html = "<div class='warn'><ul>" + "".join(f"<li>{_esc(c)}</li>" for c in packet["caveats"]) + "</ul></div>"

    not_incl = "".join(f"<li>{_esc(x)}</li>" for x in packet["not_included"])
    title = f"Farm financial packet — {_esc(op['name'] or 'Operation')} — {packet['generated_for_year']}"

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  body {{ font: 14px/1.45 -apple-system, system-ui, sans-serif; color: #111; max-width: 760px; margin: 24px auto; padding: 0 16px; }}
  h1 {{ font-size: 20px; margin: 0 0 2px; }} h2 {{ font-size: 15px; margin: 22px 0 6px; border-bottom: 1px solid #ccc; padding-bottom: 3px; }}
  .sub {{ color: #555; font-size: 12px; }}
  table {{ width: 100%; border-collapse: collapse; margin: 6px 0; }}
  td, th {{ padding: 3px 6px; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; }}
  th {{ font-size: 12px; color: #555; }} .num {{ text-align: right; white-space: nowrap; }}
  .total td {{ font-weight: 700; border-top: 2px solid #333; }}
  .warn {{ background: #fff6e5; border: 1px solid #e0b872; padding: 8px 12px; border-radius: 6px; margin: 8px 0; font-size: 13px; }}
  .warn ul {{ margin: 4px 0 0 18px; }} ul {{ margin: 4px 0; }}
  footer {{ margin-top: 24px; color: #666; font-size: 11px; }}
  @media print {{ body {{ margin: 0; }} h2 {{ page-break-after: avoid; }} }}
</style></head><body>
<h1>{_esc(op['name'] or 'Farm operation')}</h1>
<div class="sub">{_esc(op['entity_type'] or '')} {('· ' + _esc(op['state'])) if op['state'] else ''} · Tax year {packet['generated_for_year']} · Prepared {packet['generated_on']}</div>
<div class="sub">{_esc(packet['basis'])}</div>
{caveats_html}

<h2>Income statement (Schedule F basis)</h2>
<table>
  <tr><th>Income</th><th class="num">Amount</th></tr>
  {sf_income or "<tr><td>No categorized income.</td><td class='num'>—</td></tr>"}
  <tr class="total"><td>Gross farm income (Ln 9)</td><td class="num">{_usd(isr['gross_farm_income'])}</td></tr>
</table>
<table>
  <tr><th>Expenses</th><th class="num">Amount</th></tr>
  {sf_expense or "<tr><td>No categorized expenses.</td><td class='num'>—</td></tr>"}
  <tr class="total"><td>Total expenses (Ln 33)</td><td class="num">{_usd(isr['total_expenses'])}</td></tr>
</table>
<table><tr class="total"><td>Net farm income (Ln 34)</td><td class="num">{_usd(isr['net_farm_income'])}</td></tr></table>
{uncat_html}
<div class="sub">Line map: {_esc(sf['form']['form'])} v{_esc(sf['form']['version'])}{' · UNVERIFIED since ' + _esc(sf['form']['verify_by']) if sf['form']['stale'] else ''} · {_esc(sf['form']['source_url'])}</div>

<h2>Budget vs. actual by crop</h2>
<table>
  <tr><th>Crop</th><th class="num">Acres</th><th class="num">Budget</th><th class="num">Spent</th><th class="num">Income</th></tr>
  {bva_rows}
</table>

<h2>Breakeven by field</h2>
<table>
  <tr><th>Field — crop</th><th class="num">Acres</th><th class="num">Allocated cost</th><th class="num">Harvest</th><th class="num">Breakeven</th></tr>
  {be_rows}
</table>

<h2>Grain position</h2>
<table>
  <tr><th>Crop</th><th class="num">Produced (bu)</th><th class="num">Contracted</th><th class="num">Priced</th><th>Gaps</th></tr>
  {gp_rows}
</table>

<h2>Not included in this packet</h2>
<ul>{not_incl}</ul>
<footer>{_esc(packet['note'])}</footer>
</body></html>"""
