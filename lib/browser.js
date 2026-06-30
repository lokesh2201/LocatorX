const fs = require('fs');
const { isDynamicId } = require('./locators');

// ─── VERIFICATION VIEWPORTS ───────────────────────────────────────────────────
// A locator that matches exactly 1 element at one screen size can legitimately
// match 0 or 2+ at another — responsive frameworks often mount/unmount entirely
// different markup per breakpoint (e.g. a tablet-only nav variant), not just
// toggle CSS visibility. Verifying against a single fixed viewport produces
// false NO_MATCH/MULTI_MATCH results for anything breakpoint-dependent, so
// verification runs against each of these in turn. The first entry doubles as
// the viewport used for the initial page fetch + element extraction.
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'tablet',  width: 768,  height: 1024 },
  { name: 'mobile',  width: 375,  height: 667 },
];

// Resize the page and give responsive JS (resize listeners, matchMedia
// callbacks, framework re-renders) a brief moment to react before the DOM is
// queried at this size. Best-effort — never throws.
async function setViewportAndSettle(page, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.waitForTimeout(200);
  try { await page.waitForLoadState('networkidle', { timeout: 1500 }); } catch (_) {}
}

// ─── PLAYWRIGHT: FETCH + EXTRACT VISIBLE ELEMENTS ────────────────────────────

// storageStatePath: optional path to a saved session file (cookies/localStorage).
// When omitted, behaves EXACTLY as before — anonymous browsing, no auth.

async function fetchAndExtract(url, maxWaitMs = 15000, storageStatePath = null) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });

  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
    viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height },
  };

  // Only attach a saved session if one was explicitly requested AND exists.
  // This keeps the default (no session) path identical to the original code.
  if (storageStatePath && fs.existsSync(storageStatePath)) {
    contextOptions.storageState = storageStatePath;
    console.log(`  Using saved session: ${require('path').basename(storageStatePath)}`);
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: maxWaitMs });

    // ── Session expiry detection (only relevant when a session was used) ────
    // Reactive check: did we land on what looks like a login page instead of
    // the target page? If so, the saved session is dead/invalid.
    //
    // A password field ALONE is not proof of expiry — change-password pages,
    // security settings, and embedded login widgets all have one on a perfectly
    // authenticated page. Likewise a "login" substring on a page the user
    // explicitly asked for isn't expiry. So we require a stronger signal:
    //   (a) we were REDIRECTED to a login-looking URL, OR
    //   (b) we landed on a login-looking URL that shows a password form AND we
    //       did not ourselves request a login page.
    const LOGIN_URL_RE = /\/(login|signin|sign-in|auth|sso)(\/|$|\?)/;
    if (storageStatePath) {
      const finalUrlStr = page.url();
      const looksLikeLoginUrl = LOGIN_URL_RE.test(finalUrlStr.toLowerCase());

      let redirectedAway = false;
      let requestedLooksLikeLogin = false;
      try {
        const requested = new URL(url);
        const final     = new URL(finalUrlStr);
        const norm = p => p.replace(/\/+$/, '');
        redirectedAway = final.origin !== requested.origin ||
                         norm(final.pathname) !== norm(requested.pathname);
        requestedLooksLikeLogin = LOGIN_URL_RE.test((requested.pathname + requested.search).toLowerCase());
      } catch (_) { /* URL parse issue — leave defaults */ }

      const hasPasswordField = await page.$$eval(
        'input[type="password"]', els => els.length
      ).catch(() => 0);

      const sessionExpired =
        (looksLikeLoginUrl && redirectedAway) ||
        (looksLikeLoginUrl && hasPasswordField > 0 && !requestedLooksLikeLogin);

      if (sessionExpired) {
        await browser.close();
        const err = new Error(
          'SESSION_EXPIRED: The saved session appears invalid or expired — you were ' +
          'redirected to a login page. Please re-run "Login & Save Session" for this site.'
        );
        err.code = 'SESSION_EXPIRED';
        throw err;
      }
    }

    // Poll for interactable elements. The 500ms-fixed interval used to add up
    // to half a second of dead time AFTER the page was already ready (the loop
    // only checks every 500ms, so a page that becomes ready at e.g. 60ms still
    // waits until the 500ms tick). Polling at 150ms keeps the same "give slow
    // pages up to maxWaitMs" ceiling but cuts that worst-case overshoot to
    // ~150ms for fast pages, at the cost of a few extra (cheap) $$eval calls.
    const POLL_INTERVAL_MS = 150;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const count = await page.$$eval(
        'a, button, input, select, textarea, [role="button"], [data-testid]',
        els => els.length
      );
      if (count >= 3) break;
      await page.waitForTimeout(POLL_INTERVAL_MS);
    }

    // Best-effort "settle" wait. This is just a heuristic on top of the
    // element-presence check above, and it's wrapped in a silent catch — it
    // never throws or blocks correctness — so a 5s timeout was pure tax on any
    // page with persistent background network activity (analytics beacons,
    // polling, websockets) that never truly goes idle. 2s still gives normal
    // pages a fair chance to settle without making every such page pay the
    // full 5s on every analyze run.
    try { await page.waitForLoadState('networkidle', { timeout: 2000 }); } catch (_) {}

    const pageTitle = await page.title();

    const elements = await page.$$eval(
      'a, button, input, select, textarea, label, ' +
      '[role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
      '[role="tab"], [role="menuitem"], [role="textbox"], ' +
      '[data-testid], [data-cy], [name], h1, h2, h3',
      (els) => {
        const seen = new Set();
        const results = [];
        els.forEach((el, idx) => {
          // Hard excludes — never testable under any circumstance
          if (!el.isConnected) return;
          if (el.tagName === 'INPUT' && el.type === 'hidden') return;
          if (el.getAttribute('aria-hidden') === 'true') return;
          // Non-visual document metadata — these only got picked up because the
          // selector includes "[name]" and tags like <meta name="..."> match it.
          // They're never real, clickable/fillable UI elements, so they're
          // useless as test locators and just add noise to the results table.
          if (['SCRIPT', 'STYLE', 'BASE', 'NOSCRIPT'].includes(el.tagName)) return;

          // Skip pure accessibility helpers with no visual presence
          const cls = (el.getAttribute('class') || '').toLowerCase();
          if (/\b(sr-only|visually-hidden|screen-reader-only)\b/.test(cls)) return;

          // Business fix: keep elements inside dynamic containers (modals, dropdowns,
          // tooltips) even if currently hidden — testers need those locators.
          // Only hard-skip elements with ZERO size AND no useful stable attributes.
          const rect = el.getBoundingClientRect();
          const hasUsefulAttr = el.id || el.getAttribute('name') ||
                                el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
                                el.getAttribute('data-testid') || el.getAttribute('data-cy') ||
                                el.getAttribute('role') || el.getAttribute('href');
          const ownStyle = window.getComputedStyle(el);
          // Skip ONLY if: element itself has display:none AND has no useful attributes
          // AND has no dimensions (truly invisible with nothing to identify it by)
          if (ownStyle.display === 'none' && !hasUsefulAttr && rect.width === 0 && rect.height === 0) return;

          const tag         = el.tagName.toLowerCase();
          const id          = el.id || '';
          const name        = el.getAttribute('name') || '';
          const type        = el.getAttribute('type') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const ariaLabel   = el.getAttribute('aria-label') || '';
          const role        = el.getAttribute('role') || '';
          const dataTestId  = el.getAttribute('data-testid') || el.getAttribute('data-cy') || '';
          const href        = (el.getAttribute('href') || '').slice(0, 100);
          const altText     = el.getAttribute('alt') || '';
          const rawText     = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);

          const fp = `${tag}|${id}|${name}|${rawText.slice(0,40)}|${placeholder}|${ariaLabel}`;
          if (seen.has(fp)) return;
          seen.add(fp);

          const label = dataTestId || ariaLabel || placeholder || rawText || name || altText || id || `${tag}[${idx}]`;
          results.push({ tag, id, name, type, placeholder, ariaLabel, role, dataTestId, href, altText, text: rawText, label: label.slice(0, 60), index: idx });
        });
        return results;
      }
    );

    console.log(`Extracted ${elements.length} visible elements`);

    const cleaned = elements.map(el => ({ ...el, id: isDynamicId(el.id) ? '' : el.id }));
    return { page, browser, pageTitle, elements: cleaned };

  } catch (err) {
    try { await browser.close(); } catch (_) { /* already closed — fine */ }
    throw err;
  }
}

// ─── PLAYWRIGHT LOCATOR-STRING PARSING ───────────────────────────────────────
// Pulls every quoted string literal out of a fragment, honouring backslash
// escapes (so getByText('It\'s') yields  It's). Used instead of a single rigid
// regex so options like { name: 'X', exact: true }, escaped apostrophes, and
// differing option orders no longer cause a real locator to fail verification
// and get wrongly tagged NO_MATCH. Deliberately eval-free — we never execute
// the model-supplied string.
function quotedStrings(fragment) {
  const out = [];
  const re = /(['"])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(fragment)) !== null) {
    out.push(m[2].replace(/\\(['"\\])/g, '$1'));
  }
  return out;
}

// Extracts a named option's string value, e.g. optionString(s, 'name').
function optionString(fragment, key) {
  const m = fragment.match(new RegExp(key + '\\s*:\\s*([\'"])((?:\\\\.|(?!\\1).)*)\\1'));
  return m ? m[2].replace(/\\(['"\\])/g, '$1') : undefined;
}

// Resolves a Playwright getBy*/locator string into a real Locator (or null if
// it isn't a form we recognise). Never evaluates the string.
function resolvePlaywrightLocator(page, locStr) {
  const loc = locStr.trim();
  const exact = /\bexact\s*:\s*true\b/.test(loc);

  if (loc.startsWith('getByRole(')) {
    const role = quotedStrings(loc)[0];
    if (!role) return null;
    const name = optionString(loc, 'name');
    const opts = {};
    if (name !== undefined) opts.name = name;
    if (exact) opts.exact = true;
    return Object.keys(opts).length ? page.getByRole(role, opts) : page.getByRole(role);
  }

  // Single-string getBy* locators that also accept an { exact } option.
  const byExact = {
    'getByLabel(':       (v, o) => page.getByLabel(v, o),
    'getByPlaceholder(': (v, o) => page.getByPlaceholder(v, o),
    'getByText(':        (v, o) => page.getByText(v, o),
    'getByAltText(':     (v, o) => page.getByAltText(v, o),
    'getByTitle(':       (v, o) => page.getByTitle(v, o),
  };
  for (const prefix in byExact) {
    if (loc.startsWith(prefix)) {
      const v = quotedStrings(loc)[0];
      return v !== undefined ? byExact[prefix](v, exact ? { exact: true } : undefined) : null;
    }
  }

  if (loc.startsWith('getByTestId(')) {
    const v = quotedStrings(loc)[0];
    return v !== undefined ? page.getByTestId(v) : null;
  }
  if (loc.startsWith('locator(')) {
    const v = quotedStrings(loc)[0];
    return v !== undefined ? page.locator(v) : null;
  }
  return null;
}

// ─── MULTI-VIEWPORT VERIFICATION ──────────────────────────────────────────────

// Runs the batched verification of every target on ONE already-settled page.
// `selected` is { xpathSelected, cssSelected, pwSelected }; `checkCancelled` is
// called at each batch boundary and may throw to abort promptly.
async function verifyAllOnPage(page, verifyTargets, selected, concurrency, checkCancelled) {
  const { xpathSelected, cssSelected, pwSelected } = selected;
  const out = new Array(verifyTargets.length);
  for (let i = 0; i < verifyTargets.length; i += concurrency) {
    checkCancelled();
    const batch = verifyTargets.slice(i, i + concurrency);
    const res = await Promise.all(batch.map(loc => verifyLocator(
      page,
      xpathSelected ? loc.xpath            : null,
      cssSelected   ? loc.cssSelector       : null,
      pwSelected    ? loc.playwrightLocator : null,
    )));
    res.forEach((r, j) => { out[i + j] = r; });
  }
  return out;
}

// Verifies every target at all VIEWPORTS and returns a { viewportName: results[] }
// map aligned with verifyTargets.
//
// Fast path: each viewport gets its own page (the first reuses basePage, the
// rest are freshly navigated pages in the SAME context, so a saved login session
// carries over) and all viewports are verified concurrently — turning the old
// 3× sequential cost (each with its own resize+settle) into roughly 1×. If the
// fast path throws for any reason other than a user cancel (e.g. a flaky extra
// navigation), it falls back to the original sequential single-page resize so a
// run can never be broken by the optimization.
async function verifyAtViewports(basePage, url, verifyTargets, selected, opts = {}) {
  const {
    concurrency    = 8,
    maxWaitMs      = 15000,
    onViewportDone = () => {},
    checkCancelled = () => {},
  } = opts;

  // ── Fast path: one page per viewport, verified in parallel ───────────────
  try {
    checkCancelled();
    const context = basePage.context();

    const prepared = await Promise.all(VIEWPORTS.map(async (vp, idx) => {
      if (idx === 0) {
        await setViewportAndSettle(basePage, vp);
        return { vp, page: basePage, extra: false };
      }
      const pg = await context.newPage();
      await pg.setViewportSize({ width: vp.width, height: vp.height });
      await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: maxWaitMs });
      await setViewportAndSettle(pg, vp);
      return { vp, page: pg, extra: true };
    }));

    const resultsByViewport = {};
    let done = 0;
    try {
      await Promise.all(prepared.map(async ({ vp, page }) => {
        resultsByViewport[vp.name] = await verifyAllOnPage(page, verifyTargets, selected, concurrency, checkCancelled);
        onViewportDone(vp.name, ++done, VIEWPORTS.length);
      }));
    } finally {
      // Close only the extra pages; basePage belongs to the caller.
      await Promise.all(prepared.filter(p => p.extra).map(p => p.page.close().catch(() => {})));
    }
    return resultsByViewport;
  } catch (err) {
    if (err && err.code === 'CANCELLED') throw err; // a cancel must not fall back
    console.warn(`  Parallel viewport verification failed (${err.message}); falling back to sequential.`);
  }

  // ── Fallback: sequential resize of the base page (original behavior) ─────
  const resultsByViewport = {};
  let done = 0;
  for (const vp of VIEWPORTS) {
    checkCancelled();
    await setViewportAndSettle(basePage, vp);
    resultsByViewport[vp.name] = await verifyAllOnPage(basePage, verifyTargets, selected, concurrency, checkCancelled);
    onViewportDone(vp.name, ++done, VIEWPORTS.length);
  }
  return resultsByViewport;
}

// ─── LOCATOR VERIFIER ────────────────────────────────────────────────────────

async function verifyLocator(page, xpath, cssSelector, playwrightLocator) {
  const results = { xpathOk: false, cssOk: false, pwOk: false };

  // XPath: must match exactly 1 element in DOM (visible or hidden-by-parent)
  if (xpath) {
    try {
      const xCount = await page.$$eval('xpath=' + xpath, els => els.length).catch(() => 0);
      results.xpathOk = xCount === 1;
      results.xpathMatchCount = xCount;
    } catch (_) { results.xpathOk = false; results.xpathMatchCount = 0; }
  }

  // CSS: must match exactly 1 element in DOM
  if (cssSelector) {
    try {
      const cCount = await page.$$(cssSelector).then(els => els.length).catch(() => 0);
      results.cssOk = cCount === 1;
      results.cssMatchCount = cCount;
    } catch (_) { results.cssOk = false; results.cssMatchCount = 0; }
  }

  // Playwright built-in: convert getByXxx() string to a real locator and count
  // These use Playwright's own matching — they can match hidden elements too
  if (playwrightLocator) {
    try {
      const locObj = resolvePlaywrightLocator(page, playwrightLocator);
      const pwCount = locObj ? await locObj.count().catch(() => 0) : 0;
      // Accept 1 or more matches for Playwright — getByText can be lenient
      results.pwOk = pwCount >= 1;
      results.pwMatchCount = pwCount;
    } catch (_) { results.pwOk = false; results.pwMatchCount = 0; }
  }

  return results;
}

module.exports = { fetchAndExtract, verifyLocator, verifyAtViewports, VIEWPORTS, setViewportAndSettle };
