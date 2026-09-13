# CME settlements — forward curve + open interest (§1.1)

Adds the **full forward curve and open interest** for the soybean complex (ZS/ZM/ZL) + corn (ZC),
daily and keyless — the raw material for carry, old-crop/new-crop and calendar spreads, correctly
paired crush legs, and the `basis_carry_state` trigger (which currently can't fire for lack of a carry
spread). Complements `cbot_futures.js`, which only has a front-month *continuous* settle.

**Status: reachable from the Pi, adapter finalized, still OFF by default.** CME IP-blocks cloud/dev IPs
(403 from the workstation), but the probe confirmed the Pi's residential IP reaches the CmeWS JSON
endpoint (HTTP 200). It ships off because CME's IP policy can change and the data terms are CME's call —
a human flips it on with one env flag once they've re-confirmed with the probe.

**How it works:** the CmeWS JSON endpoint, per product id (soybeans 320, meal 310, oil 312, corn 300),
`…/Settlements/{id}/FUT?tradeDate=MM/DD/YYYY`, with a browser User-Agent. A day with no session returns
200 + empty, so the adapter steps back to the last settled day. (The plan's `ftp/pub/settle/stlags` text
file is **dead** — a real 404 from the Pi — and was dropped.)

## 1. Re-confirm with the probe (on the Pi)

The probe isn't in the deployed image (it's on the branch), and the app container runs a *built image*,
so `docker exec … node scripts/…` won't find it. The probe is self-contained (Node built-ins only), so
**pipe it into the container's Node** (its outbound traffic egresses from the Pi's IP):

```sh
# on your workstation, in the isa-umbrel-apps clone on this branch:
scp scripts/probe-cme-settlements.mjs umbrel@umbrel:/tmp/probe-cme.mjs
# then on the Pi:
cat /tmp/probe-cme.mjs | sudo docker exec -i isa-polibrief_web_1 node --input-type=module -
```

(No scp handy? Paste the file onto the Pi with a `cat > /tmp/probe-cme.mjs <<'EOF' … EOF` heredoc, then
run the same pipe. Once a release carries the probe in the image, the plain
`docker exec -w /app … node scripts/probe-cme-settlements.mjs` form works too.)

It resolves the last settled trade date and dumps each product's first rows verbatim, so you can confirm
the field names still match the adapter (`month`, `settle`, `openInterest`, `volume`). Exit 0 = a curve
came back.

## 2. Enable it

```sh
echo 'CME_SETTLEMENTS=1' >> /data/.env      # on the Pi; keyless, just the enable flag
sudo docker exec -w /app isa-polibrief_web_1 node src/index.js market-refresh
```

(Only takes effect once the deployed image actually carries `cme_settlements.js` — i.e. after the release
that ships this PR. Before that the running container has no adapter to enable.)

The adapter emits `cme:*` series (distinct from the interim `cbot:*` continuous series, so the two can
be compared): per-contract `cme:<prod>:<YYYY-MM>` settle + `:oi`, a `cme:<prod>:front` **lead-contract**
settle (the max-open-interest month, not the expiring nearest one), and `cme:<prod>:carry` (next − lead)
— the carry spread `basis_carry_state` needs. `maxContracts` (default 8) is set per-deployment via the
watchlist `sources.cme_settlements.maxContracts`.

## 3. Follow-ups once the curve is flowing

- Wire `cme:zs:carry` (or a full-curve carry vs. a storage-cost estimate) into `triggers.js` so
  `basis_carry_state` can finally fire.
- Pair Nov beans / Dec meal / Dec oil from the curve for a *correct* board crush margin (today's
  `cbot:crush:board-margin` uses three independent front months — see the caveats in `cbot_futures.js`).
- The Barchart decision then shrinks to "do we want ZIP-level elevator bids?" — a much smaller purchase.
