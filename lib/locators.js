// ─── VALUE ESCAPING HELPERS ──────────────────────────────────────────────────
// Attribute/text values can contain quotes and other special characters. If
// they're interpolated raw into a selector they produce a broken locator that
// fails verification and gets wrongly rejected as NO_MATCH. These helpers
// produce safely-quoted selector fragments.

// Returns a valid XPath string literal for any value. XPath has no escape
// character inside string literals, so the only way to embed both quote types
// is concat(). We pick the simplest form that works.
function xpathLiteral(value) {
  const s = String(value == null ? '' : value);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  // Contains both ' and " → build a concat() of alternating quoted pieces.
  const parts = s.split('"');
  const pieces = [];
  parts.forEach((part, i) => {
    if (part) pieces.push(`"${part}"`);
    if (i < parts.length - 1) pieces.push(`'"'`); // the literal double-quote
  });
  return `concat(${pieces.join(', ')})`;
}

// WHATWG CSS.escape polyfill — escapes a string for safe use as a CSS
// identifier (e.g. an #id). Node core has no CSS.escape, so we inline it.
function cssEscape(value) {
  const string = String(value == null ? '' : value);
  const length = string.length;
  const firstCodeUnit = string.charCodeAt(0);
  let result = '';
  let index = -1;
  while (++index < length) {
    const codeUnit = string.charCodeAt(index);
    if (codeUnit === 0x0000) { result += '�'; continue; }
    if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001F) || codeUnit === 0x007F ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002D)
    ) { result += '\\' + codeUnit.toString(16) + ' '; continue; }
    if (index === 0 && length === 1 && codeUnit === 0x002D) { result += '\\' + string.charAt(index); continue; }
    if (
      codeUnit >= 0x0080 || codeUnit === 0x002D || codeUnit === 0x005F ||
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005A) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007A)
    ) { result += string.charAt(index); continue; }
    result += '\\' + string.charAt(index);
  }
  return result;
}

// Escapes a value for use inside a double-quoted CSS attribute selector,
// e.g. [name="<here>"].
function cssAttrValue(value) {
  return String(value == null ? '' : value).replace(/[\\"]/g, '\\$&');
}

// ─── DYNAMIC ID DETECTOR ─────────────────────────────────────────────────────

const DYNAMIC_ID_PATTERNS = [
  /^\d+$/, /[a-f0-9]{8,}/i, /gwt-uid-\d+/i, /ember\d+/i,
  /ext-gen\d+/i, /yui_\d+/i, /:r\d+:/, /__\w+__\d+/,
  /^[a-z]+-[a-f0-9]{4,}-[a-f0-9]{4,}/i,
];
function isDynamicId(id) {
  return !id || DYNAMIC_ID_PATTERNS.some(p => p.test(id));
}

// ─── PLAYWRIGHT BUILT-IN LOCATOR BUILDER ─────────────────────────────────────
// Converts element attributes into Playwright's semantic locators
// e.g. getByRole('button', {name:'Login'}), getByLabel('Email'), etc.

function buildPlaywrightLocator(el) {
  // Priority: role+name > label > placeholder > testid > text > alt > fallback
  const roleMap = {
    button: 'button', a: 'link', input: null, select: 'combobox',
    textarea: 'textbox', checkbox: 'checkbox', radio: 'radio',
  };

  const roleFromAttr = el.role;
  const tagRole = roleMap[el.tag];
  const effectiveRole = roleFromAttr || tagRole;

  const name = el.ariaLabel || el.text || el.placeholder || el.altText;

  if (effectiveRole && name && name.length < 50) {
    return `getByRole('${effectiveRole}', { name: '${name.replace(/'/g,"\\'")}' })`;
  }
  if (el.ariaLabel) {
    return `getByLabel('${el.ariaLabel.replace(/'/g,"\\'")}')`;
  }
  if (el.placeholder) {
    return `getByPlaceholder('${el.placeholder.replace(/'/g,"\\'")}')`;
  }
  if (el.dataTestId) {
    return `getByTestId('${el.dataTestId.replace(/'/g,"\\'")}')`;
  }
  if (el.text && el.text.length > 0 && el.text.length < 40) {
    return `getByText('${el.text.replace(/'/g,"\\'")}')`;
  }
  if (el.altText) {
    return `getByAltText('${el.altText.replace(/'/g,"\\'")}')`;
  }
  // Fallback to CSS
  if (el.id)   return `locator('#${cssEscape(el.id)}')`;
  if (el.name) return `locator('${el.tag}[name="${cssAttrValue(el.name)}"]')`;
  return `locator('${el.tag}')`;
}

// ─── RULE-BASED FALLBACK ─────────────────────────────────────────────────────

function buildFallbackLocator(el, idx) {
  if (el.id)          return { xpath: `//*[@id=${xpathLiteral(el.id)}]`,                          cssSelector: `#${cssEscape(el.id)}`,                                strategy: 'ID-based',        confidence: 'High' };
  if (el.dataTestId)  return { xpath: `//${el.tag}[@data-testid=${xpathLiteral(el.dataTestId)}]`, cssSelector: `[data-testid="${cssAttrValue(el.dataTestId)}"]`,         strategy: 'TestID-based',    confidence: 'High' };
  if (el.name)        return { xpath: `//${el.tag}[@name=${xpathLiteral(el.name)}]`,              cssSelector: `${el.tag}[name="${cssAttrValue(el.name)}"]`,            strategy: 'Attribute-based', confidence: 'Medium' };
  if (el.ariaLabel)   return { xpath: `//${el.tag}[@aria-label=${xpathLiteral(el.ariaLabel)}]`,   cssSelector: `${el.tag}[aria-label="${cssAttrValue(el.ariaLabel)}"]`,  strategy: 'Attribute-based', confidence: 'Medium' };
  if (el.placeholder) return { xpath: `//${el.tag}[@placeholder=${xpathLiteral(el.placeholder)}]`, cssSelector: `${el.tag}[placeholder="${cssAttrValue(el.placeholder)}"]`, strategy: 'Attribute-based', confidence: 'Medium' };
  if (el.text && el.text.length < 40) return { xpath: `//${el.tag}[normalize-space()=${xpathLiteral(el.text)}]`, cssSelector: el.tag, strategy: 'Text-based', confidence: 'Low' };
  return { xpath: `(//${el.tag})[${idx + 1}]`, cssSelector: el.tag, strategy: 'Index-based', confidence: 'Low' };
}

// ─── DUPLICATE RESOLVER ───────────────────────────────────────────────────────

function deduplicateLocators(locators) {
  const xCount = {}, cCount = {};
  locators.forEach(l => {
    if (l.xpath)       xCount[l.xpath]       = (xCount[l.xpath] || 0) + 1;
    if (l.cssSelector) cCount[l.cssSelector] = (cCount[l.cssSelector] || 0) + 1;
  });
  const xSeen = {}, cSeen = {};
  // Returns NEW objects only — never mutates the input locators. The previous
  // version reassigned l.confidence / l.locatorStrategy on the originals, which
  // could surprise any caller still holding a reference to the input array.
  return locators.map(l => {
    const out = { ...l };
    if (out.xpath && xCount[out.xpath] > 1) {
      xSeen[out.xpath] = (xSeen[out.xpath] || 0) + 1;
      out.xpath = `(${l.xpath})[${xSeen[l.xpath]}]`;
      if (out.confidence === 'High') out.confidence = 'Medium';
      out.locatorStrategy = (out.locatorStrategy || '') + ' (positional)';
    }
    if (out.cssSelector && cCount[out.cssSelector] > 1) {
      cSeen[out.cssSelector] = (cSeen[out.cssSelector] || 0) + 1;
      out.cssSelector = `${l.cssSelector}:nth-of-type(${cSeen[l.cssSelector]})`;
    }
    return out;
  });
}

module.exports = {
  isDynamicId,
  buildPlaywrightLocator,
  buildFallbackLocator,
  deduplicateLocators,
};
