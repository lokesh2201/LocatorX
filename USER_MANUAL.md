# LocatorX — User Manual

**LocatorX** turns any web page into a clean set of ready-to-use test locators.
You paste a URL, the tool opens the page in a real browser, finds the elements a
user can actually see, asks an AI to write the best locator for each one, **verifies
every locator live on the page**, and gives you a results table plus an optional
Page Object Model (POM) file for Playwright or Selenium.

You don't need to know how it works internally to use it. This manual walks you
through the screen, top to bottom, in the order you'll use it.

---

## 1. What You Need Before You Start

| Requirement | Details |
|---|---|
| **The app running** | Open **http://localhost:3000** in your browser. (If it isn't running yet, see *Starting the App* at the end.) |
| **A page URL** | The web page you want locators for. Public pages work immediately; login-protected pages need a one-time login (Section 6). |
| **A Mistral API key** | Free to create at **https://console.mistral.ai**. This is what powers the AI locator generation. Your key is used only for your request and is never saved. |

---

## 2. The Screen at a Glance

The whole tool is one page, split into three areas:

```
┌─────────────────────────────────────────────┐
│  CONFIGURE   ← you fill this in              │
│  • Page URL + API Key                        │
│  • Anonymous Mode / Saved Session            │
│  • Locator Types + POM options               │
│  • [Analyze Page]                            │
├─────────────────────────────────────────────┤
│  PIPELINE    ← live progress while it runs   │
│  1 Fetch  2 Extract  3 AI  4 Verify  5 POM   │
├─────────────────────────────────────────────┤
│  RESULTS     ← appears when finished         │
│  • Stats   • Locators table                  │
│  • Rejected tab   • POM tab   • Export        │
└─────────────────────────────────────────────┘
```

---

## 3. Step-by-Step: Your First Analysis

### Step 1 — Enter the page details

- **Page URL** — paste the full address of the page you want to analyze
  (e.g. `https://your-app.com/login`). Press **Enter** here to start straight away.
- **Mistral API Key** — paste your key. It's a password field, so it shows as dots.

### Step 2 — Choose your locator types *(required)*

Under **Locator Types**, pick at least one. Click a chip to turn it on (it
highlights blue); click again to turn it off.

| Chip | Use it when… |
|---|---|
| **Playwright Built-in** | You write tests in Playwright (`getByRole`, `getByTestId`, etc.). |
| **XPath** | You need XPath expressions (works with Selenium, Playwright, etc.). |
| **CSS Selector** | You prefer CSS selectors. |

You can select more than one — each becomes its own column in the results table.
You **must** select at least one, or you'll see a reminder in red.

### Step 3 — Decide whether you want a POM file

Under **POM Export**:

- **Generate POM** (green = on) — produces a ready-to-use Page Object file.
  Leave it on if you want copy-paste-ready test code; turn it off if you only
  want the locator table.
- **Format dropdown** — choose **Playwright (JS)** or **Selenium (Java)**.

### Step 4 — Click **Analyze Page**

The pipeline bar appears and lights up each stage as it happens:

1. **Playwright Fetch** — opens the page in a real browser.
2. **Extract Elements** — finds only the elements a user can actually see.
3. **Mistral AI** — generates the best locator for each element.
4. **Verify Locators** — tests every locator live on the page.
5. **Build POM** — assembles the Page Object file (skipped if POM is off).

A timer shows how long it's taking. Most pages finish in well under a minute.

> **Need to stop?** Click **Cancel** to abort the run immediately.
> Click **Clear** to reset the form and results and start fresh.

---

## 4. Reading Your Results

When the run finishes, the **Results** area appears.

### The stats bar

| Stat | Meaning |
|---|---|
| **Elements Found** | Visible elements detected on the page. |
| **AI Generated** | Locators the AI proposed. |
| **Verified** | Locators that passed live verification — these are the ones you can trust. |

The page title and your selected locator types are also shown here.

### Tab 1 — Locators Table

This is your main deliverable: every **verified** locator, one row per element.

- Each row shows the element, its tag, and a column for each locator type you chose.
- Click the **Copy** button next to any locator to copy it to your clipboard.
- **Strategy** tells you how the locator was built (e.g. test-id, attribute, text).
- **Verified** badge confirms it matched exactly one visible element on the live page.
- Use the **search box** at the top to filter the table by element name or locator text.

> Only **high-confidence, verified** locators appear here — locators tied to stable
> attributes that won't break on minor UI changes. This is intentional: a smaller,
> trustworthy set beats a large, fragile one.

### Tab 2 — Rejected

Shows every locator that **didn't** make the cut, with the reason — useful for
understanding the page or improving it. A count badge shows how many were rejected,
and a summary bar groups them by reason:

| Tag | What it means | What you can do |
|---|---|---|
| **No Match** | Found 0 elements on the live page. | Usually nothing — the locator was simply wrong and correctly dropped. |
| **Multi Match** | Matched 2+ elements (ambiguous). | The page has repeated similar elements; ask devs to add unique `data-testid`s. |
| **Duplicate** | Same locator already used by another element. | Expected on repetitive layouts. |
| **Low Confidence** | Position-based, considered too fragile. | Safe to ignore — excluded on purpose. |
| **Viewport Dependent** | Works at some screen sizes but not all. | Check the reason text before using it in a fixed-size test. |

### Tab 3 — POM (Playwright POM / Java POM)

If you left **Generate POM** on, this tab holds the complete Page Object file:

- **Copy** — copies the whole file to your clipboard.
- **Download** — saves it as a `.js` (Playwright) or `.java` (Selenium) file,
  named after the page.

The file already includes the locators as properties/fields plus basic action
methods (fill, click, select) — drop it straight into your test project.

If POM was turned off, this tab explains how to re-run with it enabled.

---

## 5. Exporting Your Results

At the bottom of the Locators Table:

- **Export Excel (.xlsx)** — a formatted workbook with two sheets:
  *Verified Locators* and *Rejected Locators* (with full reasons).
- **Export JSON** — the verified locators as raw JSON, handy for scripting.

> **Auto-restore:** If you accidentally refresh or reload the tab, your last
> result is restored automatically so you don't lose a finished analysis.

---

## 6. Login-Protected Pages (Saved Sessions)

If the page you want needs a login, you log in **once** and LocatorX remembers
the session so it can reach any page on that site. **You type your password into
a real browser window — the tool never sees or stores it.**

### One-time setup per site

1. Put the site's URL in the **Page URL** field.
2. Click **Login & Save Session**.
3. A **visible Chrome window** opens. Log in there exactly as you normally would —
   username/password, 2FA, OTP, SSO, CAPTCHA all work because *you* are doing it.
4. Back in LocatorX, click **I'm Logged In**.
5. The session is saved and automatically selected.

### Using it afterwards

1. Enter **any** page URL on that site (not just the login page).
2. Pick your saved session from the **Saved Session** dropdown.
3. Click **Analyze Page** — it goes straight to your target page, already logged in.

### Managing sessions

- **Switch sites** — pick a different session, or **No session** for public pages.
- **Delete** — select a session and click **Delete**.
- **Sessions expire** — they auto-delete **2 hours** after being saved, and the
  dropdown shows how long ago each was saved ("saved 3 days ago"). If a session
  has expired, you'll see a red banner with a **Re-login** button — one click
  reopens the login window.

### Anonymous Mode

If you never test login-protected pages, click **Anonymous Mode (no sessions)** at
the top. This hides the session controls entirely and skips all session storage.
The setting is remembered between visits. Turn it off any time to get sessions back.

---

## 7. Quick Tips & Troubleshooting

| Situation | What to do |
|---|---|
| **"Please select at least one locator type"** | Turn on at least one of Playwright / XPath / CSS. |
| **"Please enter a page URL / API key"** | Both fields are required before analyzing. |
| **Few or no verified locators** | The page may have very few stable attributes. Check the **Rejected** tab to see why. |
| **"Session expired or invalid"** | Click **Re-login** in the red banner to refresh your saved login. |
| **Run is taking too long** | Click **Cancel** and try again — heavy pages take longer to load and verify. |
| **Local / internal URL won't load** | For security, private/localhost addresses are blocked by default. Ask whoever runs the server to enable local targets. |

---

## 8. Starting the App (if it isn't already running)

If `http://localhost:3000` doesn't open, start the server once from the project
folder:

```bash
npm install
npx playwright install chromium    # one-time, first run only
node agent.js
```

Then open **http://localhost:3000** in your browser.

---

## 9. End-to-End Flow Summary

```
Enter URL + API Key
        │
   (optional) pick a Saved Session for login-protected pages
        │
Choose Locator Types  +  POM format
        │
   Click  ▶ Analyze Page
        │
Fetch → Extract visible → AI generates → Verify live → Build POM
        │
Results:  Stats  •  Locators Table  •  Rejected  •  POM
        │
Copy / Download POM   •   Export Excel / JSON
```

That's the whole tool. Paste a URL, click Analyze, and copy out locators you can
trust.
