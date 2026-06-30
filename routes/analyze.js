const express = require('express');
const fs = require('fs');
const { isSessionExpired, resolveSessionPath, activeRuns } = require('../lib/sessionStore');
const { fetchAndExtract, verifyAtViewports, VIEWPORTS } = require('../lib/browser');
const { generateLocators } = require('../lib/mistral');
const { generatePOM } = require('../lib/pom');
const { assertSafeUrl } = require('../lib/security');
const progress = require('../lib/progress');

const router = express.Router();

const RUNID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// Throws a CANCELLED error if the user aborted this run via /api/analyze/cancel.
// Called at checkpoints between the expensive stages so a cancelled run stops
// promptly even if the browser hasn't been force-closed yet.
function throwIfCancelled(run) {
  if (run && run.cancelled) {
    const err = new Error('Run cancelled by user.');
    err.code = 'CANCELLED';
    throw err;
  }
}

// ─── MAIN API ROUTE ──────────────────────────────────────────────────────────

router.post('/analyze', async (req, res) => {
  const { url, mistralApiKey, locatorTypes = ['playwright'], generatePom = true, pomFormat = 'playwright', sessionDomain = null } = req.body;

  if (!url || !mistralApiKey)
    return res.status(400).json({ error: 'URL and Mistral API Key are required.' });
  if (!locatorTypes || locatorTypes.length === 0)
    return res.status(400).json({ error: 'Select at least one locator type (XPath, CSS, or Playwright).' });

  // Cancellation support: the client sends a runId so it can later abort this
  // run via POST /api/analyze/cancel. If none is sent (or it's malformed) we
  // generate one server-side — the run still works, it just can't be cancelled
  // from the client.
  let runId = typeof req.body.runId === 'string' ? req.body.runId : null;
  if (runId && !RUNID_RE.test(runId)) {
    return res.status(400).json({ error: 'Invalid runId.' });
  }
  if (!runId) runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Emit a pipeline progress event to any SSE subscriber for this run.
  // Step keys (p1..p5) match the pipeline DOM ids in the frontend.
  const p = (key, state, extra = {}) => progress.emit(runId, { key, state, ...extra });

  // SSRF guard: reject non-http(s) schemes and private/internal addresses
  // before any browser navigation happens.
  try {
    await assertSafeUrl(url);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  let browser = null;

  // Resolve session file path ONLY if a session was explicitly selected.
  // If sessionDomain is null (default), this stays null and behavior is
  // IDENTICAL to before — no session, no auth, exactly as it always worked.
  let storageStatePath = null;
  if (sessionDomain) {
    const candidate = resolveSessionPath(sessionDomain);
    if (!candidate) {
      return res.status(400).json({ error: `Invalid session name "${sessionDomain}".` });
    }
    if (fs.existsSync(candidate)) {
      // Lazy TTL check: if this session is older than 2 hours, treat it as
      // expired — delete it and ask the user to re-login instead of silently
      // running anonymous (which would just look like a confusing failure).
      const stat = fs.statSync(candidate);
      if (isSessionExpired(stat)) {
        try { fs.unlinkSync(candidate); } catch (_) {}
        return res.status(401).json({
          error: `Saved session "${sessionDomain}" expired (sessions auto-delete after 2 hours). Please re-run "Login & Save Session".`,
          code: 'SESSION_EXPIRED',
        });
      }
      storageStatePath = candidate;
    } else {
      return res.status(400).json({ error: `Saved session "${sessionDomain}" not found. It may have been deleted.` });
    }
  }

  // Past all early-return validation — register this run so it can be cancelled.
  // Cleaned up in the finally below, regardless of how the run ends.
  const run = { browser: null, cancelled: false, createdAt: Date.now() };
  activeRuns.set(runId, run);

  try {
    // Step 1+2: Fetch + extract visible elements
    console.log(`\n[1/4] Playwright fetch... | Types: [${locatorTypes.join(', ')}] | POM: ${generatePom} | Session: ${sessionDomain || 'none'}`);
    p('p1', 'active', { msg: 'Launching Playwright browser…' });
    let page, pageTitle, elements;
    try {
      ({ page, browser, pageTitle, elements } = await fetchAndExtract(url, 15000, storageStatePath));
    } catch (e) {
      // Surface session expiry distinctly so the UI can show a specific message
      if (e.code === 'SESSION_EXPIRED') {
        return res.status(401).json({ error: e.message, code: 'SESSION_EXPIRED' });
      }
      return res.status(400).json({ error: `Page fetch failed: ${e.message}` });
    }

    // Browser now exists — expose it to the cancel endpoint so an abort can
    // tear it down, and bail immediately if a cancel already arrived during fetch.
    run.browser = browser;
    throwIfCancelled(run);
    // Fetch + extraction both complete when fetchAndExtract resolves.
    p('p1', 'done');
    p('p2', 'done', { msg: `Extracted ${elements.length} elements`, count: elements.length });

    if (elements.length === 0) {
      await browser.close();
      return res.status(400).json({ error: 'No visible interactable elements found.' });
    }
    console.log(`  → ${elements.length} visible elements`);

    // Step 3: Mistral generates locators for selected types
    console.log('[2/4] Generating locators with Mistral AI...');
    p('p3', 'active', { msg: 'Generating locators with Mistral AI…' });
    const allLocators = await generateLocators(elements, mistralApiKey, locatorTypes);
    throwIfCancelled(run);
    p('p3', 'done', { msg: `AI generated ${allLocators.length} locators`, count: allLocators.length });

    // Step 4: Verify — High + Medium confidence, track all rejections with reasons
    console.log('[3/4] Verifying locators...');
    const verified  = [];
    const rejected  = [];
    const rejectionSummary = { LOW_CONFIDENCE: 0, NO_MATCH: 0, MULTI_MATCH: 0, DUPLICATE: 0, VIEWPORT_DEPENDENT: 0 };

    const xpathSelected = locatorTypes.includes('xpath');
    const cssSelected   = locatorTypes.includes('css');
    const pwSelected    = locatorTypes.includes('playwright');

    // ── Run live verification concurrently, at every viewport ────────────────
    // A locator that matches exactly 1 element at 1280x800 can legitimately
    // match 0 or 2+ at another breakpoint if the page is responsive — so a
    // single-viewport check produces false NO_MATCH/MULTI_MATCH results for
    // anything breakpoint-dependent. We re-run the same concurrent-batched
    // verification at each configured viewport and keep every viewport's
    // results, then classify using all of them together below.
    const verifyTargets = allLocators.filter(loc => loc.confidence !== 'Low');
    const VERIFY_CONCURRENCY = 8;

    p('p4', 'active', { msg: `Verifying ${verifyTargets.length} locators across ${VIEWPORTS.length} viewports…` });
    // Verify all viewports in parallel (one page each), falling back to a
    // sequential resize internally if the fast path can't be set up. Returns a
    // { viewportName: results[] } map aligned with verifyTargets.
    const resultsByViewport = await verifyAtViewports(
      page, url, verifyTargets,
      { xpathSelected, cssSelected, pwSelected },
      {
        concurrency:    VERIFY_CONCURRENCY,
        checkCancelled: () => throwIfCancelled(run),
        onViewportDone: (name, done, total) => p('p4', 'active', {
          msg: `Verified at ${name} (${done}/${total})…`,
          viewport: name, vpIndex: done - 1, vpTotal: total,
        }),
      },
    );
    p('p4', 'done');

    // ── Classify in original order ────────────────────────────────────────
    // This single pass mirrors the previous single-viewport loop's order and
    // LOW_CONFIDENCE/DUPLICATE decisions exactly — the difference is that a
    // locator now only counts as Verified if it passes at EVERY viewport.
    // One that passes at some viewports but not others gets a new
    // VIEWPORT_DEPENDENT tag instead of being misclassified as NO_MATCH or
    // MULTI_MATCH based on whichever single size happened to be tested.
    const verifiedXPaths = new Set();
    const verifiedCSS    = new Set();
    const verifiedPW     = new Set();
    let vi = 0; // walks verifyTargets/resultsByViewport[*] in lockstep with allLocators

    for (const loc of allLocators) {
      // ── LOW_CONFIDENCE: index-based locators excluded by policy ──────────
      if (loc.confidence === 'Low') {
        rejectionSummary.LOW_CONFIDENCE++;
        rejected.push({
          ...loc,
          rejectionTag:    'LOW_CONFIDENCE',
          rejectionReason: 'Index-based locator — breaks on any UI layout change',
        });
        continue;
      }

      // ── DUPLICATE: same locator already verified earlier ─────────────────
      const isDup = (xpathSelected && loc.xpath       && verifiedXPaths.has(loc.xpath))   ||
                    (cssSelected   && loc.cssSelector  && verifiedCSS.has(loc.cssSelector)) ||
                    (pwSelected    && loc.playwrightLocator && verifiedPW.has(loc.playwrightLocator));
      if (isDup) {
        rejectionSummary.DUPLICATE++;
        rejected.push({
          ...loc,
          rejectionTag:    'DUPLICATE',
          rejectionReason: 'Locator string already used by another verified element',
        });
        vi++;
        continue;
      }

      // Pull this locator's result at every tested viewport.
      const perViewport = VIEWPORTS.map(vp => resultsByViewport[vp.name][vi]);
      vi++;

      const passAt = perViewport.map(result =>
        (xpathSelected && result.xpathOk) || (cssSelected && result.cssOk) || (pwSelected && result.pwOk)
      );
      const passedAll  = passAt.every(Boolean);
      const passedSome = passAt.some(Boolean);

      if (passedAll) {
        // Track which locator strings are now in use (based on the first/
        // desktop viewport's pass info — all viewports passed, so any is fine)
        const result = perViewport[0];
        if (xpathSelected && loc.xpath)            verifiedXPaths.add(loc.xpath);
        if (cssSelected   && loc.cssSelector)      verifiedCSS.add(loc.cssSelector);
        if (pwSelected    && loc.playwrightLocator) verifiedPW.add(loc.playwrightLocator);

        const passedTypes = [
          xpathSelected && result.xpathOk ? 'xpath' : null,
          cssSelected   && result.cssOk   ? 'css'   : null,
          pwSelected    && result.pwOk    ? 'pw'    : null,
        ].filter(Boolean).join('+');

        verified.push({
          ...loc,
          verificationStatus: `✅ Verified (${passedTypes}) — stable across ${VIEWPORTS.map(v => v.name).join('/')}`,
        });
      } else if (passedSome) {
        // ── VIEWPORT_DEPENDENT: passes at some sizes, not others ───────────
        const passNames = VIEWPORTS.filter((vp, idx) => passAt[idx]).map(vp => vp.name);
        const failNames = VIEWPORTS.filter((vp, idx) => !passAt[idx]).map(vp => vp.name);
        const reason = `Matched exactly 1 element at: ${passNames.join(', ')} — but failed at: ${failNames.join(', ')}. ` +
          `Likely targets viewport-specific markup; confirm your intended test viewport before using.`;
        rejectionSummary.VIEWPORT_DEPENDENT++;
        console.log(`  ⚠ [VIEWPORT_DEPENDENT] ${loc.elementLabel}: ${reason}`);
        rejected.push({ ...loc, rejectionTag: 'VIEWPORT_DEPENDENT', rejectionReason: reason });
      } else {
        // Failed at every viewport — determine specific reason from the
        // desktop result (first viewport), same logic as before.
        const result = perViewport[0];
        const xCount = result.xpathMatchCount ?? 0;
        const cCount = result.cssMatchCount   ?? 0;
        const pCount = result.pwMatchCount    ?? 0;
        const maxCount = Math.max(xCount, cCount, pCount);

        let tag, reason;
        if (maxCount === 0) {
          tag    = 'NO_MATCH';
          reason = `Locator found 0 elements on page (checked at ${VIEWPORTS.map(v => v.name).join('/')})` +
            (xpathSelected ? ` | XPath matches: ${xCount}` : '') +
            (cssSelected   ? ` | CSS matches: ${cCount}`   : '') +
            (pwSelected    ? ` | PW matches: ${pCount}`    : '');
          rejectionSummary.NO_MATCH++;
        } else {
          tag    = 'MULTI_MATCH';
          reason = `Ambiguous — locator matched ${maxCount} elements at every tested viewport (must match exactly 1)` +
            (xpathSelected ? ` | XPath: ${xCount}` : '') +
            (cssSelected   ? ` | CSS: ${cCount}`   : '') +
            (pwSelected    ? ` | PW: ${pCount}`    : '');
          rejectionSummary.MULTI_MATCH++;
        }

        console.log(`  ✗ [${tag}] ${loc.elementLabel}: ${reason}`);
        rejected.push({ ...loc, rejectionTag: tag, rejectionReason: reason });
      }
    }

    console.log(`  → ${verified.length} verified | ${rejected.length} rejected`);
    console.log(`  Rejection breakdown: LOW_CONFIDENCE=${rejectionSummary.LOW_CONFIDENCE} | NO_MATCH=${rejectionSummary.NO_MATCH} | MULTI_MATCH=${rejectionSummary.MULTI_MATCH} | DUPLICATE=${rejectionSummary.DUPLICATE}`);

    await browser.close();

    // Step 5: POM (only if requested)
    let pom = null;
    if (generatePom) {
      console.log('[4/4] Building POM...');
      p('p5', 'active', { msg: 'Building Page Object Model…' });
      pom = generatePOM(verified, pageTitle, url, locatorTypes, pomFormat);
      p('p5', 'done');
    } else {
      console.log('[4/4] POM skipped (disabled by user)');
      p('p5', 'skip');
    }
    p('end', 'done');

    return res.json({
      url, pageTitle,
      totalExtracted:  elements.length,
      totalGenerated:  allLocators.length,
      totalVerified:   verified.length,
      totalRejected:   rejected.length,
      rejectionSummary,
      locatorTypes,
      generatePom,
      sessionUsed: sessionDomain || null,
      locators: verified,
      rejected,
      pom,
    });

  } catch (err) {
    if (browser) { try { await browser.close(); } catch(_) {} }
    // A user-initiated cancel isn't an error. The client has already aborted its
    // fetch and won't read this, but respond cleanly rather than logging a 500.
    if (err.code === 'CANCELLED' || run.cancelled) {
      console.log(`  Run ${runId} stopped (cancelled by user).`);
      p('end', 'cancelled');
      return res.status(200).json({ cancelled: true });
    }
    console.error(err);
    p('end', 'error', { msg: err.message || 'Something went wrong.' });
    return res.status(500).json({ error: err.message || 'Something went wrong.' });
  } finally {
    activeRuns.delete(runId);
    progress.close(runId);
  }
});

// SSE stream of pipeline progress for a run. The client opens this (with the
// same runId it will POST to /analyze) just before kicking off the analysis.
router.get('/analyze/progress', (req, res) => {
  const runId = typeof req.query.runId === 'string' ? req.query.runId : '';
  if (!RUNID_RE.test(runId)) return res.status(400).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering so events flush immediately
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write(': connected\n\n'); // comment line to open the stream

  const unsubscribe = progress.subscribe(runId, res);
  req.on('close', unsubscribe);
});

// Cancel an in-flight analyze run: flags it cancelled and force-closes its
// headless browser, which makes any in-flight Playwright calls reject promptly.
// Idempotent — unknown/already-finished runIds are treated as success.
router.post('/analyze/cancel', (req, res) => {
  const { runId } = req.body;
  if (!runId || !activeRuns.has(runId)) {
    return res.json({ success: true, note: 'No active run with that id (already finished or never started).' });
  }
  const run = activeRuns.get(runId);
  run.cancelled = true;
  if (run.browser) { run.browser.close().catch(() => {}); }
  console.log(`Analyze run cancelled by user: ${runId}`);
  return res.json({ success: true });
});

module.exports = router;
