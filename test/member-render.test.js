// 1.42.0 Member Brief rendering: charts drawn on the Pi, embedded in the email as inline (cid:) images,
// indicator tables in both the email and the web view, and the member footer (not the staff one).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-render-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
delete process.env.STATE_PACK;

const { markdownToEmailHtml, memberEmailBody } = await import("../src/deliver.js");
const { markdownToHtml, startServer } = await import("../src/server.js");
const { lineChartSvg, smallMultiplesSvg, svgToPng } = await import("../src/charts.js");

const MD = [
  "### Fund positioning",
  "",
  "![Managed-money net position <script>](charts/2026-10-07-member-fund.png)",
  "",
  "| Measure | Latest | Change |",
  "|---|---|---|",
  "| Soybeans [2] | Net long 69,000 | +1,000 w/w |",
  "",
  "![Missing chart](charts/2026-10-07-member-barge.png)",
  "",
  "Funds are net long. [2]",
].join("\n");

const isPng = (buf) => buf.subarray(1, 4).toString("latin1") === "PNG";

test("charts: a line chart and small multiples render to PNG", async () => {
  const pts = Array.from({ length: 12 }, (_, i) => ({ period: `2026-${String(i + 1).padStart(2, "0")}-01`, value: 20 + i }));
  assert.ok(isPng(await svgToPng(lineChartSvg({ title: "Test (units)", series: [{ label: "A", points: pts }], reference: { label: "3-year average", points: pts.map((p) => ({ ...p, value: p.value - 2 })) } }))));
  assert.ok(isPng(await svgToPng(smallMultiplesSvg([{ title: "Seg", series: [{ label: "Seg", points: pts }] }], { title: "Barge" }))));
});

test("email HTML: tables become <table>, a chart becomes an image only when a source is given, text is escaped", () => {
  const html = markdownToEmailHtml(MD, "S", { image: (src) => (src.endsWith("fund.png") ? "cid:fund@x" : null) });
  assert.match(html, /<table[^>]*>\s*<tr><th[^>]*>Measure<\/th>/);
  assert.match(html, /<td[^>]*>Net long 69,000<\/td>/);
  assert.ok(!/\|---/.test(html), "the separator row is not printed");
  assert.match(html, /<img src="cid:fund@x" alt="Managed-money net position &lt;script&gt;"/);
  assert.match(html, /\[Chart: Missing chart\]/, "a chart with no file falls back to its alt text");
  assert.ok(!html.includes("<script>"));
  assert.match(markdownToEmailHtml("x", "S"), /internal monitoring/, "staff briefs keep their footer");
});

test("member email: charts ride as inline attachments, the text part names them, the footer is the member one", () => {
  const dir = path.join(DIR, "briefings");
  fs.mkdirSync(path.join(dir, "charts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "charts", "2026-10-07-member-fund.png"), Buffer.from("\x89PNG fake", "latin1"));
  const { text, html, attachments } = memberEmailBody(MD, "ISA Member Brief", dir);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].cid, "2026-10-07-member-fund@member-brief");
  assert.equal(attachments[0].contentDisposition, "inline");
  assert.match(html, /src="cid:2026-10-07-member-fund@member-brief"/);
  assert.match(text, /^\[Chart: Managed-money net position <script>\]$/m);
  assert.ok(!html.includes("internal monitoring"), "members never see the staff footer");
  assert.match(html, /Education, not advice\./);
});

test("web view: tables and chart images render; only charts/ paths become images", () => {
  const html = markdownToHtml(MD);
  assert.match(html, /<table class="kpi"><thead><tr><th>Measure<\/th>/);
  assert.match(html, /<img src="\/brief\/charts\/2026-10-07-member-fund\.png" alt="Managed-money net position &lt;script&gt;"/);
  assert.ok(!markdownToHtml("![x](../../etc/passwd.png)").includes("<img"), "nothing outside charts/ is ever an image");
});

test("server: /brief/charts/<file>.png serves the PNG; anything else is 404", async () => {
  const server = await startServer({ port: 0, schedule: false });
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  const port = server.address().port;
  const get = (p) => new Promise((resolve, reject) => http.get({ port, path: p }, (res) => { const b = []; res.on("data", (c) => b.push(c)); res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(b) })); }).on("error", reject));
  try {
    const ok = await get("/brief/charts/2026-10-07-member-fund.png");
    assert.equal(ok.status, 200);
    assert.equal(ok.type, "image/png");
    assert.ok(isPng(ok.body));
    assert.equal((await get("/brief/charts/nope.png")).status, 404);
    assert.equal((await get("/brief/charts/..%2f..%2f.env")).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
