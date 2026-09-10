// auth.test.js — accounts, password hashing, signed session cookies, feed token.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as auth from "../src/auth.js";

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pb-auth-"));
  process.env.POLIBRIEF_DATA_DIR = tmp;
  delete process.env.POLIBRIEF_SESSION_SECRET;
  delete process.env.POLIBRIEF_PASSWORD;
  delete process.env.POLIBRIEF_FEED_TOKEN;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.POLIBRIEF_DATA_DIR;
});

test("no accounts + no legacy password ⇒ auth is off (app stays open)", () => {
  assert.equal(auth.userCount(), 0);
  assert.equal(auth.authEnabled(), false);
});

test("setUser then verifyPassword accepts the right pair and rejects wrong ones", () => {
  auth.setUser("matt", "beans-and-corn");
  assert.equal(auth.authEnabled(), true);
  assert.equal(auth.userCount(), 1);
  assert.equal(auth.verifyPassword("matt", "beans-and-corn"), true);
  assert.equal(auth.verifyPassword("matt", "wrong"), false);
  assert.equal(auth.verifyPassword("nobody", "beans-and-corn"), false);
});

test("passwords are never stored in the clear", () => {
  auth.setUser("dir", "super-secret-pw");
  const raw = fs.readFileSync(path.join(tmp, "users.json"), "utf8");
  assert.ok(!raw.includes("super-secret-pw"));
  assert.match(raw, /"algo": "scrypt"/);
});

test("weak passwords and bad usernames are rejected", () => {
  assert.throws(() => auth.setUser("x", "short"), /at least 8/);
  assert.throws(() => auth.setUser("has space", "longenough"), /username/);
});

test("listUsers and removeUser", () => {
  auth.setUser("a", "password-a");
  auth.setUser("b", "password-b");
  assert.deepEqual(auth.listUsers().map((u) => u.username).sort(), ["a", "b"]);
  assert.equal(auth.removeUser("a"), true);
  assert.equal(auth.removeUser("a"), false);
  assert.deepEqual(auth.listUsers().map((u) => u.username), ["b"]);
});

test("legacy POLIBRIEF_PASSWORD is accepted for any username", () => {
  process.env.POLIBRIEF_PASSWORD = "shared-legacy-pw";
  assert.equal(auth.authEnabled(), true);
  assert.equal(auth.verifyPassword("anyone", "shared-legacy-pw"), true);
  assert.equal(auth.verifyPassword("anyone", "nope"), false);
});

test("session tokens round-trip; tampering and expiry are rejected", () => {
  const tok = auth.signSession("matt");
  assert.equal(auth.verifySession(tok).username, "matt");
  assert.equal(auth.verifySession(tok + "x"), null); // tampered signature
  assert.equal(auth.verifySession("garbage"), null);
  assert.equal(auth.verifySession(auth.signSession("matt", -1000)), null); // already expired
});

test("a rotated secret invalidates existing session tokens", () => {
  const tok = auth.signSession("matt");
  assert.ok(auth.verifySession(tok));
  process.env.POLIBRIEF_SESSION_SECRET = "a-different-secret";
  assert.equal(auth.verifySession(tok), null);
});

test("session cookie carries hardening flags; Secure only over https", () => {
  const c = auth.sessionCookie("t");
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.ok(!/Secure/.test(c));
  assert.match(auth.sessionCookie("t", { secure: true }), /Secure/);
  assert.match(auth.clearCookie(), /Max-Age=0/);
});

test("parseCookies splits a Cookie header", () => {
  const c = auth.parseCookies("pb_session=abc.def; other=1");
  assert.equal(c.pb_session, "abc.def");
  assert.equal(c.other, "1");
  assert.deepEqual(auth.parseCookies(""), {});
});

test("feed token is stable within a data dir and checkable", () => {
  const t1 = auth.feedToken();
  const t2 = auth.feedToken();
  assert.equal(t1, t2); // persisted, not regenerated
  assert.equal(auth.checkFeedToken(t1), true);
  assert.equal(auth.checkFeedToken("wrong"), false);
  assert.equal(auth.checkFeedToken(""), false);
});
