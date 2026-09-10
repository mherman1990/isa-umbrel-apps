// auth.js — multi-user login for the polibrief web UI.
//
// Why this exists: the app used to gate everything behind a single shared
// password (POLIBRIEF_PASSWORD) sent as HTTP Basic auth — fine on a Tailscale-
// only network, but not something you hand a director. This module adds named
// accounts (each teammate their own username + password), a real login page
// backed by a signed session cookie, and a feed token so machine subscriptions
// (Outlook calendar, RSS) keep working without a browser session.
//
// Design notes:
//  - No new dependencies. Passwords are hashed with Node's built-in scrypt;
//    sessions are stateless HMAC-signed cookies (no DB table, survives restarts).
//  - Storage lives in the data volume next to watchlist.json / .env, so accounts
//    survive app updates and never ship inside the image.
//  - Auth is OPT-IN: with no users configured and no POLIBRIEF_PASSWORD, the app
//    stays open (the old Tailscale default). Add one user and the gate turns on.
//    So: create your accounts BEFORE you expose the app with Tailscale Funnel.
//  - The legacy POLIBRIEF_PASSWORD still works (any username) as a fallback, so
//    existing bookmarks / calendar subscriptions don't break on upgrade.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const COOKIE_NAME = "pb_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }; // ~16MB, comfortable on a Pi 5

// ---------- data-dir resolution (independent of store.js so this stays testable) ----------
function dataDir() {
  const d = process.env.POLIBRIEF_DATA_DIR
    ? path.resolve(process.env.POLIBRIEF_DATA_DIR)
    : path.dirname(path.dirname(new URL(import.meta.url).pathname));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const usersPath = () => path.join(dataDir(), "users.json");
const secretPath = () => path.join(dataDir(), ".session_secret");
const feedTokenPath = () => path.join(dataDir(), ".feed_token");

// ---------- users store (data/users.json) ----------
function readUsers() {
  try {
    const raw = fs.readFileSync(usersPath(), "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}
function writeUsers(users) {
  const file = usersPath();
  fs.writeFileSync(file, JSON.stringify(users, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on odd filesystems */ }
}

export function listUsers() {
  const users = readUsers();
  return Object.entries(users).map(([username, u]) => ({
    username,
    role: u.role ?? "viewer",
    created: u.created ?? null,
  }));
}

export function userCount() {
  return Object.keys(readUsers()).length;
}

/** Create or update an account. Password is hashed; never stored in the clear. */
export function setUser(username, password, role = "viewer") {
  username = String(username || "").trim();
  if (!username) throw new Error("username is required");
  if (!/^[A-Za-z0-9._@+-]{1,64}$/.test(username)) {
    throw new Error("username may contain only letters, numbers, and . _ @ + - (max 64)");
  }
  if (!password || String(password).length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
  });
  const users = readUsers();
  const existing = users[username];
  users[username] = {
    algo: "scrypt",
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString("hex"),
    hash: hash.toString("hex"),
    role,
    created: existing?.created ?? new Date().toISOString(),
    updated: new Date().toISOString(),
  };
  writeUsers(users);
  return { username, role };
}

export function removeUser(username) {
  const users = readUsers();
  if (!(username in users)) return false;
  delete users[username];
  writeUsers(users);
  return true;
}

/**
 * Verify a username/password pair. Returns true on success.
 * Falls back to the legacy shared POLIBRIEF_PASSWORD (any username) so existing
 * subscriptions and bookmarks keep working after the upgrade.
 */
export function verifyPassword(username, password) {
  password = String(password ?? "");
  const users = readUsers();
  const u = users[String(username ?? "")];
  if (u && u.algo === "scrypt") {
    try {
      const salt = Buffer.from(u.salt, "hex");
      const expected = Buffer.from(u.hash, "hex");
      const got = crypto.scryptSync(password, salt, expected.length, {
        N: u.N ?? SCRYPT.N, r: u.r ?? SCRYPT.r, p: u.p ?? SCRYPT.p, maxmem: 64 * 1024 * 1024,
      });
      if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) return true;
    } catch {
      /* fall through to legacy */
    }
  }
  const legacy = process.env.POLIBRIEF_PASSWORD;
  if (legacy && timingEqualStr(password, legacy)) return true;
  return false;
}

/** Auth is enforced only when at least one account exists or a legacy password is set. */
export function authEnabled() {
  return userCount() > 0 || Boolean(process.env.POLIBRIEF_PASSWORD);
}

// ---------- session cookies (stateless, HMAC-signed) ----------
function sessionSecret() {
  if (process.env.POLIBRIEF_SESSION_SECRET) return process.env.POLIBRIEF_SESSION_SECRET;
  const file = secretPath();
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    const secret = crypto.randomBytes(32).toString("hex");
    try { fs.writeFileSync(file, secret + "\n", { mode: 0o600 }); fs.chmodSync(file, 0o600); }
    catch { /* fall back to an in-memory secret; sessions won't survive a restart */ }
    return secret;
  }
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const fromB64url = (s) => Buffer.from(String(s), "base64url");

/** Mint a signed session token for a username, valid for ttlMs. */
export function signSession(username, ttlMs = SESSION_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const payload = `${b64url(String(username))}.${exp}`;
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest();
  return `${payload}.${b64url(sig)}`;
}

/** Verify a session token. Returns { username, exp } or null. */
export function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [u, expStr, sigStr] = parts;
  const payload = `${u}.${expStr}`;
  const expected = crypto.createHmac("sha256", sessionSecret()).update(payload).digest();
  let given;
  try { given = fromB64url(sigStr); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return { username: fromB64url(u).toString("utf8"), exp };
}

/** Build a Set-Cookie header value. `secure` should be true when served over HTTPS. */
export function sessionCookie(token, { secure = false, ttlMs = SESSION_TTL_MS } = {}) {
  const maxAge = Math.floor(ttlMs / 1000);
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookie({ secure = false } = {}) {
  const attrs = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const pair of String(header).split(";")) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    const k = pair.slice(0, i).trim();
    if (k) out[k] = pair.slice(i + 1).trim();
  }
  return out;
}

// ---------- feed token (lets Outlook/RSS reach /calendar.ics and /feed.xml) ----------
export function feedToken() {
  if (process.env.POLIBRIEF_FEED_TOKEN) return process.env.POLIBRIEF_FEED_TOKEN;
  const file = feedTokenPath();
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    const tok = crypto.randomBytes(18).toString("base64url");
    try { fs.writeFileSync(file, tok + "\n", { mode: 0o600 }); fs.chmodSync(file, 0o600); }
    catch { /* ephemeral token if the volume is read-only */ }
    return tok;
  }
}

export function checkFeedToken(token) {
  if (!token) return false;
  return timingEqualStr(String(token), feedToken());
}

// ---------- helpers ----------
function timingEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
