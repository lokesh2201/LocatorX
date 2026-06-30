const { test } = require('node:test');
const assert = require('node:assert');
const {
  isDynamicId,
  buildFallbackLocator,
  buildPlaywrightLocator,
  deduplicateLocators,
} = require('../lib/locators');

test('isDynamicId flags auto-generated ids and accepts stable ones', () => {
  assert.equal(isDynamicId('ember123'), true);
  assert.equal(isDynamicId('gwt-uid-4'), true);
  assert.equal(isDynamicId(':r0:'), true);
  assert.equal(isDynamicId('123456'), true);
  assert.equal(isDynamicId('a1b2c3d4e5f6'), true); // long hex
  assert.equal(isDynamicId(''), true);             // empty treated as dynamic
  assert.equal(isDynamicId('login-button'), false);
  assert.equal(isDynamicId('username'), false);
});

test('buildFallbackLocator escapes double quotes in attribute values', () => {
  const loc = buildFallbackLocator({ tag: 'input', name: 'sa"y' }, 0);
  // XPath should switch to single quotes rather than break
  assert.equal(loc.xpath, "//input[@name='sa\"y']");
  // CSS attribute value should escape the quote
  assert.ok(loc.cssSelector.includes('\\"'));
});

test('buildFallbackLocator uses concat() when value has both quote types', () => {
  const loc = buildFallbackLocator({ tag: 'button', text: `It's "x"` }, 0);
  assert.ok(loc.xpath.includes('concat('));
});

test('buildFallbackLocator escapes special chars in CSS id selector', () => {
  const loc = buildFallbackLocator({ tag: 'div', id: 'a:b.c' }, 0);
  assert.equal(loc.cssSelector, '#a\\:b\\.c');
  assert.equal(loc.xpath, '//*[@id="a:b.c"]');
});

test('deduplicateLocators disambiguates collisions without mutating input', () => {
  const input = [
    { elementLabel: 'a', xpath: '//button', cssSelector: 'button', confidence: 'High', locatorStrategy: 'X' },
    { elementLabel: 'b', xpath: '//button', cssSelector: 'button', confidence: 'High', locatorStrategy: 'X' },
  ];
  const out = deduplicateLocators(input);
  assert.equal(out[0].xpath, '(//button)[1]');
  assert.equal(out[1].xpath, '(//button)[2]');
  assert.equal(out[0].cssSelector, 'button:nth-of-type(1)');
  assert.equal(out[0].confidence, 'Medium');          // downgraded on output
  // input untouched
  assert.equal(input[0].xpath, '//button');
  assert.equal(input[0].confidence, 'High');
  assert.equal(input[0].locatorStrategy, 'X');
});

test('buildPlaywrightLocator prefers role+name', () => {
  const loc = buildPlaywrightLocator({ tag: 'button', text: 'Sign In' });
  assert.equal(loc, "getByRole('button', { name: 'Sign In' })");
});
