const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  SESSIONS_DIR,
  pruneExpiredSessions,
  sanitizeDomain,
  resolveSessionPath,
  pendingLogins,
} = require('../lib/sessionStore');
const { assertSafeUrl } = require('../lib/security');

const router = express.Router();

// ─── SESSION MANAGEMENT ROUTES ────────────────────────────────────────────────
// These are entirely separate from /api/analyze — adding them cannot break
// the existing analyze flow since that flow never calls into this code unless
// a sessionDomain is explicitly passed.

// List saved sessions with human-readable "saved X ago" timestamps
router.get('/sessions', (req, res) => {
  try {
    pruneExpiredSessions(); // drop anything older than 2h before listing
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const sessions = files.map(f => {
      const fullPath = path.join(SESSIONS_DIR, f);
      const stat = fs.statSync(fullPath);
      const savedAt = stat.mtime;
      const ageMs = Date.now() - savedAt.getTime();

      let ageLabel;
      const mins = Math.floor(ageMs / 60000);
      const hours = Math.floor(mins / 60);
      const days = Math.floor(hours / 24);
      if (days > 0)        ageLabel = `${days} day${days > 1 ? 's' : ''} ago`;
      else if (hours > 0)  ageLabel = `${hours} hour${hours > 1 ? 's' : ''} ago`;
      else if (mins > 0)   ageLabel = `${mins} min${mins > 1 ? 's' : ''} ago`;
      else                 ageLabel = 'just now';

      return {
        domain: f.replace('.json', ''),
        filename: f,
        savedAt: savedAt.toISOString(),
        ageLabel,
      };
    });
    return res.json({ sessions });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Start a headed (visible) browser for manual login. Returns a token used to
// confirm/save the session later. The browser stays open in the background.
router.post('/session/start-login', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required.' });

  // SSRF guard: same scheme/private-address checks as the analyze route.
  try {
    await assertSafeUrl(url);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  try {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: false }); // VISIBLE window
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const token = `login_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const domain = sanitizeDomain(url);
    pendingLogins.set(token, { browser, context, url, domain, createdAt: Date.now() });

    console.log(`Headed browser opened for manual login → ${url} (token: ${token})`);
    return res.json({ token, domain, message: 'Browser window opened. Log in, then confirm.' });
  } catch (err) {
    return res.status(500).json({ error: `Failed to open browser: ${err.message}` });
  }
});

// Confirm login is complete → capture storageState → save to sessions/<domain>.json
router.post('/session/confirm-login', async (req, res) => {
  const { token } = req.body;
  if (!token || !pendingLogins.has(token)) {
    return res.status(400).json({ error: 'Invalid or expired login session token.' });
  }

  const { browser, context, domain } = pendingLogins.get(token);

  try {
    const sessionPath = path.join(SESSIONS_DIR, `${domain}.json`);
    await context.storageState({ path: sessionPath });
    await browser.close();
    pendingLogins.delete(token);

    console.log(`Session saved: ${domain}.json`);
    return res.json({ success: true, domain, filename: `${domain}.json` });
  } catch (err) {
    try { await browser.close(); } catch (_) {}
    pendingLogins.delete(token);
    return res.status(500).json({ error: `Failed to save session: ${err.message}` });
  }
});

// Cancel a pending login (closes the headed browser without saving)
router.post('/session/cancel-login', async (req, res) => {
  const { token } = req.body;
  if (!token || !pendingLogins.has(token)) {
    return res.json({ success: true }); // nothing to cancel, treat as success
  }
  const { browser } = pendingLogins.get(token);
  try { await browser.close(); } catch (_) {}
  pendingLogins.delete(token);
  return res.json({ success: true });
});

// Delete a saved session file
router.delete('/sessions/:domain', (req, res) => {
  try {
    const sessionPath = resolveSessionPath(req.params.domain);
    if (!sessionPath) return res.status(400).json({ error: 'Invalid session name.' });
    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
