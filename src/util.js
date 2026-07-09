// util.js — small shared helpers for adapters (HTTP with timeouts + friendly errors).

const DEFAULT_TIMEOUT_MS = 30_000;

class SourceError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = "SourceError";
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { "user-agent": "polibrief/1.0 (policy monitoring; Iowa Soybean Association)", ...options.headers },
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new SourceError(`Request timed out after ${(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s: ${describeUrl(url)}`);
    }
    throw new SourceError(`Network error reaching ${describeUrl(url)} — is the internet up?`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

/** GET a URL and parse JSON, throwing a human-readable SourceError on any failure. */
export async function fetchJSON(url, options = {}) {
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new SourceError(`HTTP ${res.status} from ${describeUrl(url)}${hintForStatus(res.status)}${body ? ` — ${body}` : ""}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new SourceError(`Could not parse JSON from ${describeUrl(url)}`, { cause: err });
  }
}

/** GET a URL and return the body as text (for RSS/HTML sources). */
export async function fetchText(url, options = {}) {
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) {
    throw new SourceError(`HTTP ${res.status} from ${describeUrl(url)}${hintForStatus(res.status)}`);
  }
  return res.text();
}

function hintForStatus(status) {
  if (status === 401 || status === 403) return " (check the API key in .env)";
  if (status === 429) return " (rate limited — try again later)";
  if (status >= 500) return " (the service is having trouble — it will be retried next run)";
  return "";
}

// Show the host + path but strip query strings, which may contain API keys.
function describeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return String(url).split("?")[0];
  }
}

/** "YYYY-MM-DD" from an ISO string — several of the APIs filter by date, not datetime. */
export function isoDateOnly(iso) {
  return iso.slice(0, 10);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run async `fn` over `items` with at most `limit` in flight at once, returning results in the
 * SAME order as the input (a bounded Promise.all). `fn` is called as fn(item, index). Rejections
 * propagate, so callers that need fail-soft should catch inside `fn` and return a marker. Used to
 * fetch independent sources concurrently without unleashing all of them (or their hosts) at once.
 */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export { SourceError };
