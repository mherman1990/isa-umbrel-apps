# The Collector Gmail — setup & subscribe runbook

The **collector** is a dedicated Gmail (`beanbrief@gmail.com`) subscribed to every
campaign list, county-party mailer, caucus newsletter, and news source. The Pi reads
it directly over IMAP (the `email_intake` adapter) and turns each message into a
registry-attributed item. It is a **pure machine intake** — nothing is forwarded to a
personal inbox. This is the highest-leverage capture channel in v2: content that lives
nowhere with an API still lands in an inbox if you sign up.

## 1. One-time Google setup (5 minutes)

1. Sign in to **beanbrief@gmail.com**.
2. Turn on **2-Step Verification** (required before you can create an App Password):
   Google Account → Security → 2-Step Verification.
3. Create an **App Password**: Google Account → Security → App passwords → app "Mail",
   device "Other (polibrief)". Google shows a **16-character** password once — copy it.
   > ⚠️ The normal account password will NOT authenticate IMAP. You must use an App Password.
4. Make sure **IMAP is enabled**: Gmail → Settings → ⚙ → See all settings →
   Forwarding and POP/IMAP → **Enable IMAP** → Save.

## 2. Point polibrief at it

Add to `.env` (on the Pi: `~/umbrel/app-data/isa-polibrief/data/.env`):

```
EMAIL_INTAKE_HOST=imap.gmail.com
EMAIL_INTAKE_PORT=993
EMAIL_INTAKE_USER=beanbrief@gmail.com
EMAIL_INTAKE_PASS=<the 16-char App Password, no spaces>
```

Then enable the source in `watchlist.json` (`"email_intake": { "enabled": true, ... }`)
and restart the app. Until `EMAIL_INTAKE_PASS` is set the source stays skipped (fail-soft).

## 3. The plus-address convention (deterministic attribution)

Gmail delivers `beanbrief+ANYTAG@gmail.com` to the one `beanbrief` inbox. Subscribe to
each list with a **unique tag**, and the `To:` line becomes the entity id — no guessing.
The tag should match the entity's `newsletter_email` channel `org_id` in the registry
(e.g. `beanbrief+iowagop@gmail.com` → the Republican Party of Iowa).

Generate a ready-made worksheet of who to subscribe and with which address:

```
node scripts/subscribe.mjs targets
```

Where a signup form rejects `+`, subscribe with the bare `beanbrief@gmail.com` and the
adapter falls back to **sender-domain** attribution.

## 4. Subscribing (semi-automated)

- **Web signup forms** (name + email + ZIP): fill each from the worksheet. This part is
  partially automatable with browser automation, but captchas and per-form variation mean
  it's best supervised — expect to hand-do ~20–40%.
- **Double opt-in confirmations**: fully automatable. Every "confirm your subscription"
  email lands in the collector; run:
  ```
  node scripts/subscribe.mjs confirm --dry-run   # see what it would click
  node scripts/subscribe.mjs confirm             # actually click the confirm links
  ```
  It scans unseen mail from the last 7 days, finds confirmation links, and GETs them.

**Pace yourself.** Subscribing a brand-new Gmail to hundreds of lists in an hour can trip
Gmail's own spam heuristics and some senders' bot detection. Spread it over days.

## 5. How a message becomes an item

`email_intake` pulls new mail since the last run, parses it, and attributes it to a
registry entity — plus-tag first, then sender domain (`registry.resolveEntity`). Attributed
items get the entity score boost so a tracked entity's message reaches the brief even with
no keyword hit. Unattributed mail still flows but only survives if it hits a topic keyword.

## Security notes

- The App Password lives only in `.env` (gitignored on the repo, root-owned in `/data` on the Pi).
- The collector is a throwaway identity holding no sensitive data — keep it separate from personal/work accounts.
- Revoke the App Password anytime from the Google Account security page; the pipeline just skips until a new one is set.
