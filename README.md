# AI LocatorX

Paste a URL → Real browser opens the page → Only visible elements extracted → Mistral AI generates locators → Every locator verified live → Output: clean table + ready-to-use Page Object file in **Playwright (JavaScript)** or **Java (Selenium + PageFactory)**.

---

## Quick Start

```bash
npm install
npx playwright install chromium    # one-time setup
node agent.js
```

Open **http://localhost:3000** in your browser.

Get a free Mistral key at → https://console.mistral.ai

---

## Full Pipeline

```
You type URL + Mistral API Key
            │
            ▼
┌─────────────────────────────┐
│  STEP 1 — Playwright Fetch  │
│                             │
│  • Launches headless        │
│    Chromium browser         │
│  • Navigates to URL         │
│  • Ignores SSL errors       │
│  • Smart wait: polls every  │
│    150ms until elements     │
│    appear (max 15s)         │
│  • Waits for network idle   │
│    so XHR/lazy content      │
│    finishes loading         │
└────────────┬────────────────┘
             │ Full JS-rendered page
             ▼
┌─────────────────────────────┐
│  STEP 2 — Visible Element   │
│           Extraction        │
│                             │
│  Runs INSIDE the browser    │
│  using real browser APIs:   │
│                             │
│  ✓ getComputedStyle()       │
│    → checks display, visi-  │
│      bility, opacity        │
│  ✓ getBoundingClientRect()  │
│    → checks actual width,   │
│      height, position       │
│  ✓ Filters out:             │
│    • display:none elements  │
│    • visibility:hidden      │
│    • opacity:0 overlays     │
│    • zero-size elements     │
│    • off-screen slides      │
│    • aria-hidden="true"     │
│    • sr-only / visually-    │
│      hidden CSS classes     │
│    • input[type=hidden]     │
│    • dynamic IDs (ember123, │
│      gwt-uid-4, :r0:, hex)  │
└────────────┬────────────────┘
             │ Only truly visible elements
             ▼
┌─────────────────────────────┐
│  STEP 3 — Mistral AI        │
│                             │
│  Elements sent in chunks    │
│  of 25 to Mistral AI        │
│  (mistral-small-latest)     │
│                             │
│  AI priority order:         │
│  1. data-testid / data-cy   │
│  2. Stable semantic ID      │
│  3. name / aria-label       │
│  4. placeholder             │
│  5. Visible text (short)    │
│  6. Positional index        │
│     (last resort)           │
│                             │
│  Returns per element:       │
│  • XPath                    │
│  • CSS Selector             │
│  • Strategy used            │
│  • Confidence level         │
│                             │
│  On rate limit (429):       │
│  Retries with backoff       │
│  10s → 20s → 40s            │
└────────────┬────────────────┘
             │ AI-generated locators
             ▼
┌─────────────────────────────┐
│  STEP 4 — Locator           │
│           Verification      │
│                             │
│  Filter: High confidence    │
│  only pass through          │
│                             │
│  For each locator:          │
│  • Run XPath on live page   │
│    → must match exactly 1   │
│      VISIBLE element        │
│  • Run CSS on live page     │
│    → must match exactly 1   │
│      VISIBLE element        │
│                             │
│  Result:                    │
│  XPath=1 AND CSS=1 → ✅ Keep│
│  Anything else     → ❌ Drop│
└────────────┬────────────────┘
             │ Verified, unique, visible locators only
             ▼
┌─────────────────────────────┐
│  STEP 5 — POM Generation    │
│                             │
│  Auto-builds a Page Object  │
│  Model in your chosen       │
│  format (UI dropdown):      │
│  • Playwright (JavaScript)  │
│  • Java (Selenium +         │
│    PageFactory @FindBy)     │
│                             │
│  • Class name from title    │
│  • Locator property/field   │
│    per verified element     │
│  • Action methods:          │
│    fill(), click(),         │
│    select()                 │
│  • Duplicate labels get     │
│    auto-suffixed names      │
└────────────┬────────────────┘
             │
             ▼
   ┌─────────────────────┐
   │  UI OUTPUT          │
   │  • Stats bar        │
   │    (Found /         │
   │     Generated /     │
   │     Verified)       │
   │  • Locators table   │
   │    with ⎘ copy btn  │
   │  • POM tab: view,   │
   │    copy, download   │
   │  • Export CSV/JSON  │
   └─────────────────────┘
```

---

## Why Playwright for Extraction (Not Cheerio)

**The old problem:**

```
Playwright renders page → saves HTML → Cheerio parses HTML
```

Cheerio is a static HTML parser. It has no idea what CSS is applied at runtime. So it would include hidden modals, collapsed menus, off-screen carousel slides, and `display:none` elements — resulting in locators for things a real user cannot see or interact with.

**The fix:**

```
Playwright renders page → page.$$eval() runs filter INSIDE Chromium
```

Everything now runs inside the real browser using actual browser APIs — `getComputedStyle`, `getBoundingClientRect` — the exact same checks the browser uses to decide what a user sees.

---

## Visibility Checks Applied

| Check | Elements Filtered Out |
|---|---|
| `display: none` (computed) | CSS-hidden elements, JS-toggled panels |
| `visibility: hidden` | Elements taking space but not shown |
| `opacity: 0` | Invisible overlays, faded-out content |
| `width = 0` or `height = 0` | Collapsed menus, zero-size placeholders |
| Off-screen (left/right) | Carousel slides not currently visible |
| `aria-hidden="true"` | Decorative/screen-reader-only elements |
| `sr-only`, `visually-hidden` | Bootstrap/Tailwind accessibility helpers |
| `input[type=hidden]` | Form fields never visible to user |
| Dynamic IDs | ember123, gwt-uid-4, :r0:, hex strings |

---

## Edge Cases Handled

| Scenario | How Handled |
|---|---|
| JS/React/Angular pages | Playwright executes JS — full rendered DOM |
| Java pages (JSF, Vaadin, Spring MVC) | Smart wait polls until elements appear, max 15s |
| Slow XHR / lazy content | networkidle wait — pauses until AJAX settles |
| Legacy SSL / self-signed certs | `ignoreHTTPSErrors: true` in Playwright |
| Hidden elements in DOM | In-browser visibility filter removes them |
| Duplicate locators (same XPath for 2 elements) | Post-processor adds `(xpath)[n]` / `nth-of-type(n)` |
| Locator matches 0 or 2+ elements | Verification rejects — `NO_MATCH` vs `MULTI_MATCH` tagged from the real per-type match counts |
| Attribute/text values with quotes or special chars | Safely escaped — XPath via quote-switching / `concat()`, CSS via identifier + attribute-value escaping |
| Model drops/reorders/merges items in its response | Locators are mapped back to their source element by an echoed `ref`; anything omitted is rule-based backfilled (no mis-attribution, no lost elements) |
| Playwright locator with `exact: true`, escaped apostrophes, `getByTitle` | Verified correctly by an eval-free parser (no false `NO_MATCH`) |
| Mistral rate limit (429) | Exponential backoff: 10s → 20s → 40s, 3 retries |
| Mistral returns bad JSON | Rule-based fallback from element attributes |
| Empty page | Clear error with suggestion |

---

## Locator Confidence Levels

| Level | When Assigned | Stable? |
|---|---|---|
| **High** | data-testid, stable ID, name, aria-label | ✅ Yes — tied to semantic attributes |
| **Medium** | placeholder, visible text | ⚠ Mostly — text can change |
| **Low** | Positional index | ❌ Breaks on UI changes |

Only **High confidence + verified** locators appear in the output.

---

## Output: Playwright POM Example

```js
// ============================================================
// Page Object Model — Auto-generated by AI LocatorX
// Page  : Login Page
// URL   : https://example.com/login
// Date  : 2026-06-16
// Note  : Only HIGH confidence, visible & verified locators
// ============================================================

const { expect } = require('@playwright/test');

class LoginPagePage {
  constructor(page) {
    this.page = page;
    this.url  = 'https://example.com/login';
  }

  async navigate() { await this.page.goto(this.url); }

  // ── Locators ──────────────────────────────────────────────

  // input | Attribute-based | Confidence: High
  get username() { return this.page.locator('[name="username"]'); }
  get usernameByXPath() { return this.page.locator('xpath=//input[@name="username"]'); }

  // input | Attribute-based | Confidence: High
  get password() { return this.page.locator('[name="password"]'); }
  get passwordByXPath() { return this.page.locator('xpath=//input[@name="password"]'); }

  // button | Text-based | Confidence: High
  get loginButton() { return this.page.locator('button[type="submit"]'); }
  get loginButtonByXPath() { return this.page.locator('xpath=//button[@type="submit"]'); }

  // ── Actions ───────────────────────────────────────────────

  async fillUsername(value) { await this.username.fill(value); }
  async fillPassword(value) { await this.password.fill(value); }
  async clickLoginButton()  { await this.loginButton.click(); }

  // ── Helpers ───────────────────────────────────────────────

  async waitForPageLoad() { await this.page.waitForLoadState('networkidle'); }
}

module.exports = { LoginPagePage };
```

---

## Output: Java (Selenium + PageFactory) POM Example

Select **Java (Selenium)** from the POM format dropdown to get a `.java` file
instead. It uses `@FindBy` annotations + `PageFactory`, built from the same
verified locators:

```java
// ============================================================
// Page Object Model — Auto-generated by AI LocatorX
// Page     : Login Page
// URL      : https://example.com/login
// Locators : Selenium WebDriver (CSS preferred, XPath fallback)
// ============================================================

package com.locators.pages;

import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.FindBy;
import org.openqa.selenium.support.PageFactory;
import org.openqa.selenium.support.ui.Select;

public class LoginPagePage {

    private final WebDriver driver;
    private final String url = "https://example.com/login";

    // input | Attribute-based | Confidence: High
    @FindBy(css = "[name=\"username\"]")
    private WebElement username;

    // button | Text-based | Confidence: High
    @FindBy(css = "button[type=\"submit\"]")
    private WebElement loginButton;

    public LoginPagePage(WebDriver driver) {
        this.driver = driver;
        PageFactory.initElements(driver, this);
    }

    public void navigate() { driver.get(url); }

    public void fillUsername(String value) {
        username.clear();
        username.sendKeys(value);
    }

    public void clickLoginButton() { loginButton.click(); }
}
```

**Format notes:**
- **CSS is preferred, XPath is the fallback** for each `@FindBy`.
- Playwright built-in locators (`getByRole`, `getByTestId`, …) have **no Selenium
  equivalent**, so any element that has *only* a Playwright locator is **skipped**
  and noted in the file header.
- Both formats de-duplicate property/field names — two elements with the same
  visible label become `submit` / `submit2` rather than silently colliding.

Both templates are produced from the **same verified locator set**; only the
output template differs (see [lib/pom.js](lib/pom.js)).

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Server | Node.js + Express | Lightweight, no build step |
| Browser | Playwright (Chromium) | Real browser — handles JS, Java, SSL, visibility |
| AI | Mistral `mistral-small-latest` | Free tier, fast, native JSON mode |
| Frontend | Vanilla HTML/CSS/JS | Zero dependencies, just open browser |

---

## Security

This tool drives a real browser against URLs you supply and stores authenticated
session state on disk, so several hardening measures are built in.

### SSRF protection (Server-Side Request Forgery)

Both endpoints that navigate a browser (`/api/analyze` and
`/api/session/start-login`) validate the URL **before** any navigation happens,
via `assertSafeUrl()` in [lib/security.js](lib/security.js):

- **Scheme allow-list** — only `http` and `https` are permitted (`file:`,
  `ftp:`, `gopher:`, etc. are rejected).
- **Private/internal address blocking** — the hostname is resolved and every
  resulting address is checked. Requests to loopback (`127.0.0.0/8`, `::1`),
  private ranges (`10/8`, `172.16/12`, `192.168/16`, IPv6 ULA), link-local
  (`169.254/16` — which includes the **cloud metadata endpoint**
  `169.254.169.254`), and `localhost` are refused with HTTP 403.
- **Local-target override** — testing a locally-hosted app is a valid use case,
  so private targets can be re-enabled by setting `ALLOW_PRIVATE_TARGETS=1`.

### Path-traversal protection

Saved sessions are addressed by a domain name supplied by the client. Every
such name is passed through `resolveSessionPath()`
([lib/sessionStore.js](lib/sessionStore.js)), which:

- rejects anything that isn't a simple name (`^[A-Za-z0-9._-]+$`, no slashes, no `..`), and
- confirms the resolved file path stays **directly inside** the `sessions/`
  directory before any read/delete.

This closes traversal attempts like `DELETE /api/sessions/..%2f..%2ffoo` or an
`analyze` request with `sessionDomain: "../../etc/x"` (both now return
`400 Invalid session name`).

### Resource-leak protection

The "Login & Save Session" flow opens a **visible** browser that previously
stayed open forever if the user walked away. Abandoned login flows are now
swept after 10 minutes (`prunePendingLogins`), and **all** open login browsers
are closed on graceful shutdown (`SIGINT`/`SIGTERM`) so no orphaned Chromium
processes are left behind.

### Other measures

- **CORS locked down** — the SPA is same-origin, so no cross-origin access is
  granted by default. Set `ALLOWED_ORIGIN` to explicitly permit a specific
  origin.
- **Request body cap** — JSON bodies are limited to 256 KB.
- **Secrets never persisted** — the Mistral API key is supplied per request and
  is never written to disk or logged. Saved sessions contain cookies/tokens
  (not passwords), live only in the local `sessions/` folder, are **git-ignored**,
  and auto-expire after 2 hours.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `ALLOW_PRIVATE_TARGETS` | _unset_ | Set to `1` to allow analyzing localhost / private-IP targets |
| `ALLOWED_ORIGIN` | _unset_ | Explicit CORS origin to allow (otherwise cross-origin is disabled) |
| `MISTRAL_CONCURRENCY` | `3` | How many locator-generation chunks to send to Mistral in parallel |

> ⚠️ This is intended as a **local developer tool**. It has no user
> authentication — do not expose it directly to untrusted networks. If you must,
> put it behind an authenticating reverse proxy and review the settings above.

---

## Performance

Several stages of the pipeline are optimized to keep analysis fast without
changing the verification semantics or output:

### Parallel multi-viewport verification

Every locator is verified at three viewports (desktop / tablet / mobile). This
used to run **sequentially** — three full passes, each with its own
resize + network-settle wait. It now runs the viewports **in parallel**, one
page per viewport in the same browser context (so a saved login session still
applies), via `verifyAtViewports()` in [lib/browser.js](lib/browser.js).

- The three per-viewport settle waits (each up to ~1.7s of `networkidle`) now
  **overlap** instead of stacking, and the per-locator match checks run
  concurrently across viewports.
- Measured **~1.9× faster** on a 40-locator synthetic page; the gain is larger
  on real pages where the network-settle waits dominate.
- **Safety net:** if the parallel path can't be set up (e.g. a flaky extra
  navigation), it automatically **falls back to the original sequential**
  single-page approach, so the optimization can never break a run. User
  cancellation still aborts promptly at every batch boundary.

### Parallel Mistral chunking

Locator generation sends elements to Mistral in chunks of 25. Chunks are now
dispatched in **parallel waves** (default 3, set via `MISTRAL_CONCURRENCY`)
instead of strictly one at a time, while preserving original output order.
The adaptive backoff is retained: the moment any chunk in a wave is
rate-limited, the delay grows and the pipeline **drops to serial** for the
remainder to recover gracefully. A run that is never rate-limited pays no
per-wave tax.

### Locally-vendored Excel library

The Excel (`.xlsx`) export library is **vendored** at
[public/vendor/xlsx.full.min.js](public/vendor/xlsx.full.min.js) and loaded
locally first (works offline and under strict CSP), falling back to the CDN only
if the local copy is missing.

---

## Tests

Pure-logic modules are covered by a dependency-free test suite using Node's
built-in runner:

```bash
npm test        # runs: node --test
```

Covers selector escaping, locator de-duplication/immutability, both POM output
formats (Playwright + Java), and the SSRF address/scheme checks
([test/](test/)).

---

## Project Structure

`agent.js` is a thin entry point — it wires up Express, static file serving, and the two route modules, then starts listening. All real logic lives in `lib/` (pure functions, no HTTP awareness) and `routes/` (Express routers that call into `lib/`):

```
agent.js                 Express app setup + listen — no business logic
routes/
  analyze.js             POST /api/analyze — the main fetch → generate → verify → POM pipeline
  sessions.js            Session management endpoints (list/start-login/confirm-login/cancel-login/delete)
lib/
  browser.js             Playwright: fetchAndExtract() + verifyLocator()
  mistral.js             Mistral AI call + retry/backoff + adaptive chunk delay + prompt building
  locators.js            Locator string helpers: escaping, dedup, fallback builder, dynamic-ID detection
  pom.js                 Page Object Model file generation (Playwright JS + Java Selenium)
  sessionStore.js        Saved-session paths + path-traversal guard, TTL/expiry, pending-login registry
  security.js            SSRF guard: URL scheme + private/internal address validation
test/                    Dependency-free node:test suites for the pure modules
  locators.test.js
  pom.test.js
  security.test.js
public/
  index.html             Frontend UI — including the Anonymous Mode toggle (skips session storage entirely)
sessions/                Saved storageState JSON files (cookies/localStorage), gitignored, auto-expire after 2h
```

Each `lib/` module is independently testable — it takes plain arguments and returns plain data, with no `req`/`res` objects — which is what makes it possible to verify the analyze pipeline's logic (chunking, retries, verification, classification) without spinning up the full server.

---

## Interview Q&A

**Q: Why Playwright instead of axios + Cheerio for fetching?**

Axios only gets the initial HTML skeleton — the server response before any JavaScript runs. Java apps (JSF, Vaadin) and modern JS frameworks (React, Angular) render the actual content after page load. Playwright runs a real browser, executes JavaScript, and waits for the DOM to fully build — exactly what a user would see.

---

**Q: Why extract elements inside Playwright instead of parsing HTML with Cheerio?**

Cheerio parses raw HTML text. It has no access to computed CSS, so it can't tell if an element is `display:none`, has zero dimensions, or is positioned off-screen. By running extraction inside `page.$$eval()`, we use the browser's own `getComputedStyle` and `getBoundingClientRect` APIs — the same ones the browser uses to decide what's actually visible.

---

**Q: How does locator verification work?**

After Mistral generates a locator, the Playwright browser (still open on the page) runs it live — at three viewports (desktop 1280×800, tablet 768×1024, mobile 375×667), not just one. We check that the XPath matches exactly 1 visible element AND the CSS selector matches exactly 1 visible element, at every viewport. If either returns 0 or 2+ at ANY viewport, the locator is rejected (or tagged `VIEWPORT_DEPENDENT` if it passes at some viewports but not others). Checking only one fixed viewport used to produce false `NO_MATCH`/`MULTI_MATCH` results for responsive pages that mount different DOM per breakpoint — multi-viewport verification catches that instead of misclassifying it. The three viewports are verified **in parallel** (one page each in the same browser context), so the responsive coverage adds little wall-clock time; if the parallel path can't be set up it falls back to verifying them sequentially.

---

**Q: Why only High confidence locators?**

In test automation, a fragile locator breaks on any UI change. High confidence means the locator is tied to a stable attribute — `data-testid`, `name`, `aria-label` — things developers set intentionally and rarely change. Returning only these gives a smaller but completely reliable set. It's better to have 20 trustworthy locators than 80 that break next sprint.

---

**Q: What is the Page Object Model (POM)?**

POM is a design pattern where each page in your app has a corresponding class. Locators are `get` properties, and actions (`click`, `fill`) are methods. It separates test logic from page structure — if a locator changes, you fix it in one class, and every test that uses it automatically gets the fix. It also makes tests readable: `await loginPage.fillUsername('admin')` is clearer than a raw locator call inline.

---

**Q: How does the agent handle Mistral rate limits?**

The agent chunks elements into groups of 25. The delay *between* chunks is adaptive rather than fixed: it starts at 0ms (no wait at all) and only grows — capped at 10s — when a chunk actually comes back rate-limited, decaying back toward 0ms once chunks start succeeding cleanly again. A run that never gets rate-limited pays no per-chunk tax. Within a single chunk, the agent also uses exponential backoff on 429 errors — waits 10s, then 20s before the next retry (3 attempts total). If all retries fail, it falls back to rule-based locator generation using element attributes directly, so the pipeline never fully crashes.

---

**Q: What makes this an "AI Agent" vs just an API call?**

An AI agent makes decisions and takes actions across multiple steps autonomously. This agent: decides how long to wait for a page to load, escalates from fast-fetch to smart-wait based on element count, chunks data intelligently, retries on failure with backoff, verifies its own outputs and discards bad ones, and produces a structured artifact (POM) — all without human intervention between steps. It's not just calling an AI API once; it's an autonomous pipeline with error recovery.

---

## Rejected Locators

Every locator that fails verification is tracked with a specific tag and reason — not silently dropped.

### Rejection Tags

| Tag | Color | Meaning |
|---|---|---|
| `NO_MATCH` | 🔴 Red | Locator found **0 elements** on the live page — XPath/CSS is wrong or targets a removed element |
| `MULTI_MATCH` | 🟡 Yellow | Locator matched **2+ elements** — ambiguous, can't be used safely in tests |
| `DUPLICATE` | 🔵 Blue | Exact same locator string already verified for another element earlier |
| `LOW_CONFIDENCE` | ⚫ Grey | Index-based locator (e.g. `(//button)[3]`) — excluded by policy as too fragile |
| `VIEWPORT_DEPENDENT` | 🟣 Purple | Matches exactly 1 element at some tested viewports (desktop/tablet/mobile) but not all — page renders different DOM per breakpoint |

### Where to Find Them

- **"Rejected" tab** in the UI — appears next to the Locators Table tab with a live count badge
- **Rejection Summary bar** at the top of the Rejected tab — shows count per tag at a glance
- **Excel export** — Sheet 2 "Rejected Locators" includes all rejected locators with full reason column
- **Terminal logs** — each rejection prints `✗ [TAG] elementLabel: reason` for debugging

### How to Use Rejection Data

- High `NO_MATCH` count → Mistral generated wrong attributes; check if the page uses non-standard HTML
- High `MULTI_MATCH` count → Page has many similar elements (e.g. repeated buttons); add `data-testid` attributes to the app
- High `DUPLICATE` count → Page has repeated structural elements; use index-based as a last resort
- `LOW_CONFIDENCE` → Safe to ignore; these are intentionally excluded
- `VIEWPORT_DEPENDENT` → Locator works at some screen sizes only; check the reason text for which viewports passed/failed before using it in a fixed-size test run

---

## Excel Export (.xlsx)

The export button generates a fully formatted Excel workbook with **two sheets**:

### Sheet 1 — Verified Locators
- All verified, High/Medium confidence locators
- Columns: #, Element, Type, (selected locator types), Strategy, Confidence, Status
- Header row: dark green background
- Frozen top row + first column (scroll without losing context)

### Sheet 2 — Rejected Locators
- All rejected locators with full rejection detail
- Extra columns: Rejection Tag, Reason
- Header row: dark red background
- Frozen top row + first column

### Column Widths
All columns are pre-sized — XPath/CSS columns wide enough to show full locator strings without manual resizing.

---

## Login-Protected Pages (Saved Sessions)

For pages that require login, the agent uses Playwright's `storageState` pattern — the same approach professional QA teams use for authenticated test automation. The agent never sees or stores your password.

### How It Works

```
ONE-TIME SETUP (per site)
==========================
1. Type the site's URL in the Page URL field
2. Click "Login & Save Session"
3. A VISIBLE Chrome window opens
4. You log in manually — username/password, 2FA, OTP, SSO redirects,
   CAPTCHA — handle it exactly like you normally would
5. Click "I'm Logged In" in the chat UI
6. Agent captures cookies + localStorage + sessionStorage
7. Saved to: sessions/<domain>.json
   (e.g. sessions/premium-emdha-sa.json)

EVERY ANALYSIS AFTER THAT
==========================
1. Type ANY page URL on that site — not just the page you logged in on
2. Select your saved session from the dropdown
3. Agent loads the saved cookies into a fresh browser context
4. Navigates DIRECTLY to your target URL, already authenticated
5. Extraction, AI generation, verification — all proceed exactly
   as with public pages
```

### Why This Approach

The saved session is just an authentication "key" — it has nothing to do with which page you land on. Once the key is loaded into the browser context, you can navigate to any page within that app directly, not just the page you happened to log in from.

This also means complex logins (2FA, OTP, SSO via Google/Microsoft, CAPTCHA) are handled naturally — because a human is doing the actual login in a real visible browser, the agent never needs custom code per login type.

### Session Expiry

Saved session files also auto-delete **2 hours** after they were saved/refreshed, regardless of what the website's own cookie expiry says. This is a fixed, agent-side TTL — not configurable per session — checked lazily (no background timer):

```
- GET /api/sessions  → prunes any session file older than 2h before listing
                        (expired ones simply disappear from the dropdown)
- POST /api/analyze  → if the selected session is older than 2h, it's deleted
                        on the spot and the request fails with
                        code: SESSION_EXPIRED, prompting you to re-login
```

Separately, the website's own cookie/session rules can invalidate a session **before** that 2-hour mark. The agent has no way to predict this in advance, so it also detects that case **reactively**:

```
After navigating with a saved session, the agent treats it as expired only on
a STRONG signal (a password field alone is NOT enough — change-password and
security-settings pages have one on a perfectly valid session):

  - We were REDIRECTED to a login-looking URL (/login, /signin, /auth, /sso), OR
  - We landed on a login-looking URL that shows a password form AND we did not
    ourselves request a login page.

If so → stop immediately, don't extract garbage locators
      → show: "Session expired or invalid — please re-login"
```

A "Re-login" button appears directly in that error banner — one click reopens the headed browser flow.

### Session Age Display

Each saved session shows a human-readable timestamp in the dropdown:

```
premium-emdha-sa  —  saved 3 days ago
staging-myapp     —  saved 2 hours ago
```

This isn't a validity guarantee — just a helpful signal. If you know your app's sessions typically die after 24 hours and you see "saved 3 days ago," you already know to re-login before even trying.

### Managing Saved Sessions

- **Switch sites**: just pick a different session from the dropdown, or select "No session" for public pages
- **Delete a session**: select it, click the Delete button next to the dropdown
- **Auto-delete**: every session also self-deletes 2 hours after it was saved — no manual cleanup needed
- **Re-login**: click "Login & Save Session" again — it overwrites the existing file for that domain (and resets its 2-hour clock)

### API Endpoints (for reference)

| Endpoint | Purpose |
|---|---|
| `GET /api/sessions` | List saved sessions with age labels |
| `POST /api/session/start-login` | Opens a visible browser for manual login |
| `POST /api/session/confirm-login` | Captures and saves the authenticated state |
| `POST /api/session/cancel-login` | Closes the login browser without saving |
| `DELETE /api/sessions/:domain` | Deletes a saved session file |

### Security Notes

- Credentials are **never** transmitted to or stored by the agent — you type them directly into the real browser window, same as visiting the site normally
- Session files contain cookies/tokens, not passwords — equivalent security to staying logged into a site in your own browser
- Session files are stored locally in the `sessions/` folder — they never leave your machine
