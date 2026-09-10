# Letting teammates & directors review The Bean Brief

Goal: let colleagues open The Bean Brief in a normal browser — **no Tailscale on their
device, no Umbrel login, no SSH into the Pi** — behind a username/password login.

Two pieces, both already built into the app as of v1.32.0:

1. **An in-app login page** with named accounts (each person their own username + password),
   a signed session cookie, and logout. It replaces the old single shared-password popup.
2. **A public HTTPS URL** via **Tailscale Funnel** — this reuses the Tailscale already on the
   Pi to publish one port to the open internet. Viewers just open the link; Funnel is invisible
   to them.

> The app still spends Anthropic tokens when someone clicks a run or the Ask box. That's
> accepted for now (see the note at the bottom if you want to lock those down later).

---

## Do this in order — accounts first, *then* expose

The login gate is **opt-in**: with zero accounts it stays open (the old Tailscale-only
default). It turns on the moment the first account exists. So create the accounts **before**
you turn on Funnel, or the app is briefly public with no gate.

### 1. Create accounts (turns the gate on)

Open a shell on the Pi and run the CLI inside the app container. The container name is
`isa-polibrief_web_1`:

```bash
# interactive — prompts for the password (nothing lands in shell history)
docker exec -it isa-polibrief_web_1 node src/index.js user add matt --role admin
docker exec -it isa-polibrief_web_1 node src/index.js user add jsmith        # a director
docker exec -it isa-polibrief_web_1 node src/index.js user add board-review  # a shared review login

docker exec -it isa-polibrief_web_1 node src/index.js user list
```

- `--role` is a label only (`admin`/`editor`/`viewer`); everyone can currently see everything.
- Passwords must be ≥ 8 characters. They're hashed with scrypt — never stored in the clear.
- Accounts live in `/data/users.json` on the Pi's app-data volume, so they **survive app
  updates and restarts**. Nothing about accounts ships inside the Docker image.

Confirm the gate is on: reload the tile UI — the **Logs & Settings → Access & accounts** panel
should say "Login is ON", and the container log at startup prints `🔒 Login is ON — N accounts`.

### 2. Publish the port with Tailscale Funnel

Funnel has two one-time prerequisites in the **Tailscale admin console**
(https://login.tailscale.com/admin):

- **HTTPS certificates** enabled (DNS → "Enable HTTPS").
- **Funnel** allowed for the Pi — add a `funnel` node attribute in the ACL policy (Tailscale's
  Funnel page shows the exact `nodeAttrs` snippet, or use the per-device "Funnel" toggle).

Then, from a shell on the Pi, find the port the UI is actually reachable on locally and funnel
it. For an Umbrel app the web UI answers on **8484** inside the container; confirm what's
reachable from the host:

```bash
curl -s localhost:8484/health && echo   # prints: ok   (if this works, funnel 8484)
# if that doesn't answer, find the published host port:
docker ps --format '{{.Names}}\t{{.Ports}}' | grep polibrief
```

Publish it (run in the Tailscale context — on Umbrel that's the host `tailscale` CLI):

```bash
sudo tailscale funnel --bg 8484        # serve local :8484 publicly over HTTPS, in the background
sudo tailscale funnel status           # shows the public https://<pi>.<tailnet>.ts.net URL
```

That `https://<pi-name>.<tailnet>.ts.net` URL is what you send to teammates. Funnel serves
HTTPS on 443 automatically (Let's Encrypt via Tailscale) — nothing to configure.

To stop publishing later: `sudo tailscale funnel --bg 8484 off` (or `tailscale funnel reset`).

> **Umbrel wrinkle:** Umbrel runs its own Tailscale. If the host `tailscale` CLI can't reach it
> or Funnel is greyed out, enable Tailscale in **Umbrel → Settings** first; if Funnel still
> isn't available through Umbrel's integration, install Tailscale directly on the Pi host and
> run the commands above there. The app change in this repo is independent of which route you
> pick — it just needs *some* HTTPS front door pointed at port 8484.

### 3. Send the link

Give each person the `…ts.net` URL and their username/password. They open it, land on the
login page, and they're in. Sessions last 30 days; there's a **Sign out** button on the
Logs & Settings page.

---

## Keeping calendar & RSS subscriptions working

Outlook (calendar) and RSS readers can't fill in a login form, so they use a **feed token**
instead. On **Logs & Settings → Comment-deadline calendar & brief feed** you'll see the exact
tokenized paths:

```
https://<pi>.<tailnet>.ts.net/calendar.ics?token=…
https://<pi>.<tailnet>.ts.net/feed.xml?token=…
```

Subscribe with those. Keep the token private (anyone with it can read the feed). Rotate it by
deleting `/data/.feed_token` and restarting the app. Saved `https://user:pass@…/calendar.ics`
subscriptions also still work — HTTP Basic auth is accepted against the same accounts.

---

## Managing accounts

```bash
docker exec -it isa-polibrief_web_1 node src/index.js user add <name>     # create OR reset a password
docker exec -it isa-polibrief_web_1 node src/index.js user list
docker exec -it isa-polibrief_web_1 node src/index.js user rm <name>
```

- **Reset a password:** `user add <name>` again (it overwrites).
- **Log everyone out at once** (e.g. someone left): set a new `POLIBRIEF_SESSION_SECRET` in
  `/data/.env` and restart — all existing session cookies stop verifying. (Leaving it unset
  uses an auto-generated secret in `/data/.session_secret`, which persists across restarts.)
- **Turn the gate off** (back to open): remove all accounts and unset `POLIBRIEF_PASSWORD`.

---

## Security notes

- The app is never exposed by opening a router port — Funnel makes an **outbound** connection,
  so your Pi's IP and home/office network stay private.
- The gate is the whole perimeter once you're public. It protects a runtime that holds your
  Anthropic key, SMTP creds, and the collector Gmail app password (all in `/data/.env`) — so
  use real passwords and don't paste the URL anywhere public.
- **`/logs` is visible to any signed-in user.** It's the last 500 lines of server output. If
  you'd rather directors not see raw logs, tell me and I'll gate `/logs` (and the run/Ask
  buttons) behind the `admin` role — the role field is already recorded per account.
- Token cost: any signed-in user can trigger runs and the Ask box, which spend tokens. Fine
  for now per your call; ask and I'll make those admin-only while leaving all reading open.
