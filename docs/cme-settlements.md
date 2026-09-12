# CME settlements — forward curve + open interest (§1.1)

Adds the **full forward curve and open interest** for the soybean complex (ZS/ZM/ZL) + corn (ZC),
daily and keyless — the raw material for carry, old-crop/new-crop and calendar spreads, correctly
paired crush legs, and the `basis_carry_state` trigger (which currently can't fire for lack of a carry
spread). Complements `cbot_futures.js`, which only has a front-month *continuous* settle.

**Status: prepped but OFF.** CME IP-blocks cloud/dev IPs (both the CmeWS JSON endpoint and
`ftp/pub/settle/stlags` return 403 from the workstation — verified). The open question is whether the
Pi's residential/business IP is blocked too. So the adapter stays inert until proven on the Pi.

## 1. Probe from the Pi

```sh
sudo docker exec -w /app isa-polibrief_web_1 node scripts/probe-cme-settlements.mjs
```

It tries both routes (the CmeWS JSON endpoint per product, and the `stlags` text file), prints HTTP
status + a parsed sample for each, saves the raw responses under a temp dir, and exits 0 if at least
one route returned a soybean curve. **If it prints raw `stlags` lines, paste them back** — the text
parser (`parseStlags`) is provisional and needs pinning to the real column layout.

- **Exit 0 / curve parsed** → go to step 2.
- **Exit 1 / all 403** → the Pi's IP is blocked too. Fall back to Barchart OnDemand
  (`docs/market-data-options.md`) or contact CME's GCC (gcc@cmegroup.com). Leave the adapter off.

## 2. Enable it

Once the probe confirms a route works and the field names/units in `src/adapters/cme_settlements.js`
match the raw dump:

```sh
echo 'CME_SETTLEMENTS=1' >> /data/.env      # on the Pi; keyless, just the enable flag
sudo docker exec -w /app isa-polibrief_web_1 node src/index.js market-refresh
```

The adapter emits `cme:*` series (distinct from the interim `cbot:*` continuous series, so the two can
be compared): per-contract `cme:<prod>:<YYYY-MM>` settle + `:oi`, a `cme:<prod>:front` nearest-contract
settle, and `cme:<prod>:carry` (2nd − 1st) — the carry spread `basis_carry_state` needs.

## 3. Follow-ups once the curve is flowing

- Wire `cme:zs:carry` (or a full-curve carry vs. a storage-cost estimate) into `triggers.js` so
  `basis_carry_state` can finally fire.
- Pair Nov beans / Dec meal / Dec oil from the curve for a *correct* board crush margin (today's
  `cbot:crush:board-margin` uses three independent front months — see the caveats in `cbot_futures.js`).
- The Barchart decision then shrinks to "do we want ZIP-level elevator bids?" — a much smaller purchase.
