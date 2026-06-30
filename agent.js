const express = require('express');
const cors = require('cors');
const path = require('path');

const sessionsRouter = require('./routes/sessions');
const analyzeRouter  = require('./routes/analyze');
const { pendingLogins, activeRuns } = require('./lib/sessionStore');

const app = express();

// CORS is locked down by default. The SPA is served from this same origin, so
// no cross-origin access is needed. Set ALLOWED_ORIGIN to explicitly permit a
// specific origin (e.g. a separately-hosted frontend); otherwise cross-origin
// browser requests are not granted CORS headers.
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || false }));

// Cap request body size — these endpoints only ever receive small JSON payloads.
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Touches lib/sessionStore once at startup so the sessions/ directory exists
// before the first request — same behavior as before the file split.
require('./lib/sessionStore');

app.use('/api', sessionsRouter);
app.use('/api', analyzeRouter);

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`\n🚀 LocatorX running at http://localhost:${PORT}\n`));

// Graceful shutdown: close any headed login browsers still open so we don't
// leave orphaned Chromium processes behind.
async function shutdown(signal) {
  console.log(`\n${signal} received — closing open browsers and shutting down...`);
  for (const [, entry] of pendingLogins) {
    try { await entry.browser.close(); } catch (_) { /* already closed — fine */ }
  }
  // Also close any headless browsers from in-flight analyze runs.
  for (const [, run] of activeRuns) {
    try { if (run.browser) await run.browser.close(); } catch (_) { /* already closed — fine */ }
  }
  server.close(() => process.exit(0));
  // Hard-exit fallback if connections don't drain in time.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
