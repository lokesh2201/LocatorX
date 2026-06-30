const { Mistral } = require('@mistralai/mistralai');
const { buildPlaywrightLocator, buildFallbackLocator, deduplicateLocators } = require('./locators');

// ─── MISTRAL LOCATOR GENERATOR ────────────────────────────────────────────────

// Returns { content, rateLimited } — rateLimited is true if a 429/rate-limit
// response was ever observed for this call (even if a later retry succeeded),
// so the caller can decide whether to slow down before the NEXT chunk.
async function callMistralWithRetry(client, prompt, retries = 3) {
  let delay = 10000;
  let rateLimited = false;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await client.chat.complete({
        model: 'mistral-small-latest',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        responseFormat: { type: 'json_object' },
      });
      return { content: res.choices[0].message.content.trim(), rateLimited };
    } catch (err) {
      const isRate = err.message && (err.message.includes('429') || err.message.includes('rate'));
      if (isRate) rateLimited = true;
      if (isRate && attempt < retries) {
        console.log(`Rate limited. Retrying in ${delay/1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
      } else {
        err.rateLimited = rateLimited;
        throw err;
      }
    }
  }
}

// Build a single rule-based locator entry for one element. Used both when a
// whole chunk fails (API/parse error) and when the model silently omits an
// individual element from its response — so every extracted element always
// ends up with at least a fallback locator instead of being lost.
function buildFallbackEntry(el, globalIdx, wants) {
  const fb = buildFallbackLocator(el, globalIdx);
  const entry = {
    elementLabel:    el.label,
    elementType:     el.tag,
    locatorStrategy: fb.strategy + ' (fallback)',
    confidence:      fb.confidence,
  };
  if (wants.xpath)      entry.xpath            = fb.xpath;
  if (wants.css)        entry.cssSelector       = fb.cssSelector;
  if (wants.playwright) entry.playwrightLocator = buildPlaywrightLocator(el);
  return entry;
}

// locatorTypes: array of selected types e.g. ['xpath','css','playwright']
async function generateLocators(elements, apiKey, locatorTypes) {
  const client = new Mistral({ apiKey });
  const CHUNK_SIZE = 25;

  const wantXPath      = locatorTypes.includes('xpath');
  const wantCSS        = locatorTypes.includes('css');
  const wantPlaywright = locatorTypes.includes('playwright');
  const wants = { xpath: wantXPath, css: wantCSS, playwright: wantPlaywright };

  // Build dynamic prompt instructions based on selected types
  const outputFields = [];
  outputFields.push('"ref": number  // copy the EXACT "ref" of the element this locator describes');
  if (wantXPath)      outputFields.push('"xpath": string');
  if (wantCSS)        outputFields.push('"cssSelector": string');
  if (wantPlaywright) outputFields.push('"playwrightLocator": string  // e.g. getByRole(\'button\', {name:\'Login\'}) or getByLabel(\'Email\') or getByPlaceholder(\'Search\') or getByTestId(\'submit-btn\') or getByText(\'Click me\')');

  const typeInstructions = [];
  if (wantXPath) typeInstructions.push(
    '- XPath STRICT RULES (follow exactly):' +
    '\n  * ALWAYS wrap text comparisons in normalize-space(): //tag[normalize-space()=\"text\"]' +
    '\n  * NEVER use @class or contains(@class,...) — classes are dynamic and will break' +
    '\n  * NEVER use positional predicates like [1],[2] unless absolutely no other option' +
    '\n  * PREFER: @id, @name, @type, @placeholder, @aria-label, @data-testid, @href, @value' +
    '\n  * For text buttons/links: //button[normalize-space()=\"Login\"] NOT //button[@class=\"btn\"]' +
    '\n  * If element has @name: //input[@name=\"email\"] — always prefer this over text' +
    '\n  * Example good XPaths: //*[@id=\"submit\"], //input[@placeholder=\"Email\"], //button[normalize-space()=\"Sign In\"]'
  );
  if (wantCSS) typeInstructions.push(
    '- CSS STRICT RULES:' +
    '\n  * PREFER: #id, [name=""], [type=""], [placeholder=""], [aria-label=""], [data-testid=""]' +
    '\n  * NEVER use class selectors (.btn, .primary) — they are dynamic' +
    '\n  * Example good CSS: input[name=\"email\"], button[type=\"submit\"], [data-testid=\"login-btn\"]'
  );
  if (wantPlaywright) typeInstructions.push(
    '- Playwright built-in STRICT RULES:' +
    '\n  * Priority: getByRole > getByLabel > getByPlaceholder > getByTestId > getByText > locator()' +
    '\n  * For getByRole name: use the VISIBLE TEXT exactly as shown in the element text field' +
    '\n  * getByRole examples: getByRole(\'button\', { name: \'Sign In\' }), getByRole(\'link\', { name: \'Home\' })' +
    '\n  * getByLabel: use the label text associated with an input' +
    '\n  * NEVER use locator() with a class selector'
  );

  // Process a single chunk independently → returns { entries, rateLimited }.
  // It touches no shared state, so chunks can run concurrently (see the driver
  // below) and have their entries reassembled in original order.
  async function processChunk(chunk, offset) {
    // Attach a per-chunk "ref" the model must echo back on each locator. This
    // lets us map every returned locator to its EXACT source element by ref
    // rather than by array position — so if the model drops, reorders, or
    // merges items, locators are no longer silently attached to the wrong
    // element (the previous positional `chunk[j]` assumption).
    const chunkForPrompt = chunk.map((el, idx) => ({ ref: idx, ...el }));

    const prompt = `You are a senior test automation engineer. Generate locators for these VISIBLE web elements.

LOCATOR TYPES REQUESTED: ${locatorTypes.join(', ')}

PRIORITY ORDER (apply to all types):
1. data-testid / data-cy → High confidence
2. Stable semantic ID (not auto-generated) → High confidence
3. name / aria-label / placeholder → Medium confidence
4. Visible text (short, unique) → Medium confidence
5. Positional index → Low confidence (last resort only)

TYPE-SPECIFIC RULES:
${typeInstructions.join('\n')}

Skip dynamic IDs: ember123, gwt-uid-4, :r0:, long hex strings, pure numbers.

ELEMENTS:
${JSON.stringify(chunkForPrompt, null, 2)}

Return JSON with key "locators". Return EXACTLY ONE item per element above, and
copy that element's "ref" value into the item's "ref" field. Each item MUST include:
{
  "ref": number,
  "elementLabel": string,
  "elementType": string,
  "locatorStrategy": string,
  "confidence": "High" | "Medium" | "Low",
  ${outputFields.join(',\n  ')}
}`;

    let text, rateLimited = false;
    try {
      const result = await callMistralWithRetry(client, prompt);
      text = result.content;
      rateLimited = result.rateLimited;
    } catch (err) {
      console.error(`Chunk failed: ${err.message}. Using rule-based fallback.`);
      return {
        entries: chunk.map((el, idx) => buildFallbackEntry(el, offset + idx, wants)),
        rateLimited: !!err.rateLimited,
      };
    }

    const enriched = [];
    try {
      const parsed = JSON.parse(text);
      const arr = parsed.locators || parsed;
      const list = Array.isArray(arr) ? arr : [arr];

      // Map each returned locator back to its source element by the "ref" the
      // model echoed. Positional index is only a last-resort fallback for when
      // a ref is missing/out of range. We track which chunk elements actually
      // got covered so any the model silently dropped can be backfilled below.
      const coveredIdx = new Set();
      list.forEach((loc, j) => {
        if (!loc || typeof loc !== 'object') return;

        let idx = null;
        if (Number.isInteger(loc.ref) && loc.ref >= 0 && loc.ref < chunk.length) {
          idx = loc.ref;                 // trusted: model echoed a valid ref
        } else if (j < chunk.length && !coveredIdx.has(j)) {
          idx = j;                       // fallback: positional, only if free
        }
        const srcEl = idx !== null ? chunk[idx] : null;
        if (idx !== null) coveredIdx.add(idx);
        delete loc.ref;                  // internal-only; don't leak to output

        // Sanitise XPath: strip class-based predicates, enforce normalize-space
        if (wantXPath && loc.xpath) {
          let xp = loc.xpath;
          // Remove [@class=...] or [contains(@class,...)] — always dynamic
          xp = xp.replace(/\[@class=[^\]]+\]/g, '');
          xp = xp.replace(/\[contains\(@class,[^\]]+\]\]/g, '');
          // Fix bare text() comparisons → normalize-space()
          xp = xp.replace(/\[text\(\)\s*=\s*["']([^"']+)["']\]/g, '[normalize-space()="$1"]');
          // Fix contains(text(),...) → normalize-space trick
          xp = xp.replace(/\[contains\(text\(\),\s*["']([^"']+)["']\)\]/g, '[contains(normalize-space(),"$1")]');
          loc.xpath = xp || loc.xpath;
        }

        // Sanitise CSS: strip pure class selectors
        if (wantCSS && loc.cssSelector) {
          let css = loc.cssSelector;
          // If selector is ONLY classes (e.g. ".btn.primary") replace with tag fallback
          if (/^(\.[a-zA-Z][\w-]*)+$/.test(css.trim()) && srcEl) {
            css = srcEl.tag || 'div'; // fall back to tag
            loc.confidence = 'Low';
          }
          loc.cssSelector = css;
        }

        // Fill missing/bad Playwright locators rule-based
        if (wantPlaywright && (!loc.playwrightLocator || loc.playwrightLocator.length < 5) && srcEl) {
          loc.playwrightLocator = buildPlaywrightLocator(srcEl);
        }

        enriched.push(loc);
      });

      // Backfill any element the model silently dropped (no locator with its
      // ref, and its positional slot wasn't claimed) so nothing is lost.
      chunk.forEach((el, idx) => {
        if (coveredIdx.has(idx)) return;
        enriched.push(buildFallbackEntry(el, offset + idx, wants));
      });
    } catch (_) {
      return {
        entries: chunk.map((el, idx) => buildFallbackEntry(el, offset + idx, wants)),
        rateLimited,
      };
    }

    return { entries: enriched, rateLimited };
  }

  // ── Concurrency driver with adaptive backoff ─────────────────────────────
  // Several chunks run in parallel (default 3, override with MISTRAL_CONCURRENCY).
  // The adaptive delay applies BETWEEN waves; the moment any chunk in a wave
  // reports a rate-limit we grow that delay and drop to serial (concurrency 1)
  // for the remainder so we recover instead of hammering the API. A run that is
  // never rate-limited pays no per-wave tax. Results are reassembled in order.
  const chunks = [];
  for (let i = 0; i < elements.length; i += CHUNK_SIZE) {
    chunks.push({ items: elements.slice(i, i + CHUNK_SIZE), offset: i });
  }
  const perChunk = new Array(chunks.length);

  let concurrency = Math.max(1, Number(process.env.MISTRAL_CONCURRENCY) || 3);
  let chunkDelay = 0;
  const CHUNK_DELAY_STEP = 2000;
  const CHUNK_DELAY_MAX  = 10000;

  let ci = 0;
  while (ci < chunks.length) {
    if (chunkDelay > 0) {
      console.log(`  Backing off ${chunkDelay}ms before next batch (recent rate-limit)...`);
      await new Promise(r => setTimeout(r, chunkDelay));
    }
    const waveSize = Math.min(concurrency, chunks.length - ci);
    console.log(`Chunks ${ci + 1}-${ci + waveSize}/${chunks.length} (concurrency ${concurrency}) | types: [${locatorTypes.join(', ')}]`);

    const wave = [];
    for (let k = 0; k < waveSize; k++) {
      const at = ci + k;
      wave.push(processChunk(chunks[at].items, chunks[at].offset).then(r => {
        perChunk[at] = r.entries;
        return r.rateLimited;
      }));
    }
    const anyRateLimited = (await Promise.all(wave)).some(Boolean);
    ci += waveSize;

    if (anyRateLimited) {
      chunkDelay = Math.min(CHUNK_DELAY_MAX, chunkDelay > 0 ? chunkDelay * 2 : CHUNK_DELAY_STEP);
      concurrency = 1; // recover by going serial for the remainder
    } else {
      chunkDelay = Math.max(0, chunkDelay - CHUNK_DELAY_STEP);
    }
  }

  return deduplicateLocators(perChunk.flat());
}

module.exports = { callMistralWithRetry, generateLocators };
