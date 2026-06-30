const fs = require('fs');
const path = require('path');

// ─── SESSION STORAGE SETUP ────────────────────────────────────────────────────
// Saved sessions live here as <domain>.json files (cookies + localStorage).
// Created once per site via the "Login & Save Session" flow — never via the
// normal /api/analyze flow, so the existing pipeline is untouched.

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Saved sessions auto-expire 2 hours after they were last saved/refreshed.
// This is a lazy TTL: nothing runs on a timer — expiry is checked whenever
// the session list is read or a session is about to be used, and the stale
// file is deleted at that point.
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function isSessionExpired(stat) {
  return (Date.now() - stat.mtimeMs) > SESSION_TTL_MS;
}

// Scans sessions/ and deletes any file older than SESSION_TTL_MS.
// Safe to call often — it's just a stat + conditional unlink per file.
function pruneExpiredSessions() {
  let removed = 0;
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const fullPath = path.join(SESSIONS_DIR, f);
      try {
        const stat = fs.statSync(fullPath);
        if (isSessionExpired(stat)) {
          fs.unlinkSync(fullPath);
          removed++;
          console.log(`  Session expired (>2h) and removed: ${f}`);
        }
      } catch (_) { /* file may have been removed concurrently — ignore */ }
    }
  } catch (_) { /* sessions dir issue — ignore, non-fatal */ }
  return removed;
}

function sanitizeDomain(url) {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/[^a-zA-Z0-9.-]/g, '').replace(/\./g, '-');
  } catch (_) {
    return 'unknown-domain';
  }
}

// Safely resolves a client-supplied domain name to its session file path.
// Guards against path traversal: the domain must be a simple name (no slashes,
// no "..") and the resolved file must stay directly inside SESSIONS_DIR.
// Returns the absolute path, or null if the domain is invalid.
function resolveSessionPath(domain) {
  if (typeof domain !== 'string') return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(domain) || domain.includes('..')) return null;
  const candidate = path.resolve(SESSIONS_DIR, `${domain}.json`);
  if (path.dirname(candidate) !== path.resolve(SESSIONS_DIR)) return null;
  return candidate;
}

// In-memory registry of pending headed-login sessions awaiting confirmation.
// Keyed by a short-lived token so multiple browser tabs don't collide.
// Each entry carries a createdAt timestamp so abandoned flows can be swept.
const pendingLogins = new Map(); // token -> { browser, context, url, domain, createdAt }

// A headed browser is opened when a login flow starts and only closed on
// confirm/cancel. If the user walks away, that browser (and this Map entry)
// would leak forever. Sweep anything older than this TTL.
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function prunePendingLogins() {
  const now = Date.now();
  for (const [token, entry] of pendingLogins) {
    if (now - (entry.createdAt || 0) > PENDING_LOGIN_TTL_MS) {
      try { await entry.browser.close(); } catch (_) { /* already closed — fine */ }
      pendingLogins.delete(token);
      console.log(`  Abandoned login flow expired (>10min); browser closed: ${token}`);
    }
  }
}

// In-memory registry of in-flight /api/analyze runs, keyed by a short-lived
// runId the client generates per analyze call. This lets a separate
// POST /api/analyze/cancel request find a run the user abandoned and tear down
// its headless browser, instead of letting the Playwright work (and the Mistral
// call) run to completion in the background.
const activeRuns = new Map(); // runId -> { browser, cancelled, createdAt }

// Defensive sweep only: a normal run removes its own entry when it finishes.
// This catches entries orphaned if a run dies unexpectedly before cleanup.
const ACTIVE_RUN_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function pruneActiveRuns() {
  const now = Date.now();
  for (const [id, entry] of activeRuns) {
    if (now - (entry.createdAt || 0) > ACTIVE_RUN_TTL_MS) {
      try { if (entry.browser) await entry.browser.close(); } catch (_) { /* already closed — fine */ }
      activeRuns.delete(id);
      console.log(`  Orphaned analyze run swept (>10min); browser closed: ${id}`);
    }
  }
}

// Periodic background sweep. unref() so this timer never keeps the process
// alive on its own.
const _pendingSweeper = setInterval(() => { prunePendingLogins(); pruneActiveRuns(); }, 60 * 1000);
if (_pendingSweeper.unref) _pendingSweeper.unref();

module.exports = {
  SESSIONS_DIR,
  SESSION_TTL_MS,
  PENDING_LOGIN_TTL_MS,
  isSessionExpired,
  pruneExpiredSessions,
  sanitizeDomain,
  resolveSessionPath,
  pendingLogins,
  prunePendingLogins,
  activeRuns,
  pruneActiveRuns,
};
