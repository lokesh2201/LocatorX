const { test } = require('node:test');
const assert = require('node:assert');
const { generatePOM } = require('../lib/pom');

const sample = [
  { elementLabel: 'Email', elementType: 'input', confidence: 'High', locatorStrategy: 'css', cssSelector: '#email', xpath: '//input[@id="email"]', playwrightLocator: null },
  { elementLabel: 'Submit', elementType: 'button', confidence: 'High', locatorStrategy: 'css', cssSelector: '#s1', xpath: null, playwrightLocator: null },
  { elementLabel: 'Submit', elementType: 'button', confidence: 'High', locatorStrategy: 'css', cssSelector: '#s2', xpath: null, playwrightLocator: null },
  { elementLabel: 'Home', elementType: 'a', confidence: 'High', locatorStrategy: 'pw', cssSelector: null, xpath: null, playwrightLocator: "getByRole('link', { name: 'Home' })" },
];

test('Playwright POM de-duplicates colliding property names', () => {
  const pom = generatePOM(sample, 'Login', 'http://x', ['css', 'xpath', 'playwright'], 'playwright');
  // Both "Submit" elements only have a CSS selector → ByCss getters
  assert.ok(pom.includes('get submitByCss()'));
  assert.ok(pom.includes('get submit2ByCss()'));   // second "Submit" suffixed
  assert.ok(pom.includes('module.exports'));
});

test('Java POM emits @FindBy fields and de-duplicates names', () => {
  const pom = generatePOM(sample, 'Login', 'http://x', ['css', 'xpath', 'playwright'], 'java');
  assert.ok(pom.includes('@FindBy(css = "#email")'));
  assert.ok(pom.includes('private WebElement submit;'));
  assert.ok(pom.includes('private WebElement submit2;'));
  assert.ok(pom.includes('PageFactory.initElements'));
});

test('Java POM skips Playwright-only locators and notes the skip', () => {
  const pom = generatePOM(sample, 'Login', 'http://x', ['css', 'xpath', 'playwright'], 'java');
  // "Home" has only a playwrightLocator → no Selenium equivalent → skipped
  assert.ok(!pom.includes('private WebElement home'));
  assert.ok(/1 element\(s\) skipped/.test(pom));
});

test('Java POM prefers CSS over XPath in @FindBy', () => {
  const locs = [{ elementLabel: 'Field', elementType: 'input', confidence: 'High', locatorStrategy: 'x', cssSelector: '#f', xpath: '//input[@id="f"]', playwrightLocator: null }];
  const pom = generatePOM(locs, 'P', 'http://x', ['css', 'xpath'], 'java');
  assert.ok(pom.includes('@FindBy(css = "#f")'));
  assert.ok(!pom.includes('@FindBy(xpath'));
});
