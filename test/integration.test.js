// Integration test for the /api/analyze pipeline: real Express app + real
// Playwright fetch/verify against a local test page, exercising the SSE progress
// stream, the full analyze response, the cancel flow, and input validation.
//
// Only the external Mistral call is stubbed (deterministic, no API key needed) —
// it's overridden on the module BEFORE the analyze router is required, so the
// router captures the stub. Everything else is the production code path.
//
// Requires Playwright's Chromium (already a project dependency). Set
// SKIP_ANALYZE_INTEGRATION=1 to skip (e.g. on a machine without browsers).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const SKIP = process.env.SKIP_ANALYZE_INTEGRATION === '1';
let prevAllowPrivate;

// ── Stub Mistral before requiring the router that destructures it ──
const mistral = require('../lib/mistral');
let stubDelayMs = 0; // toggled per-test to make a run slow enough to cancel
mistral.generateLocators = async (elements, _apiKey, types) => {
  if (stubDelayMs) await new Promise(r => setTimeout(r, stubDelayMs));
  const wantX = types.includes('xpath'), wantC = types.includes('css'), wantP = types.includes('playwright');
  return elements.map(el => {
    // Elements with a stable id verify cleanly; those without become LOW_CONFIDENCE.
    if (!el.id) return { elementLabel: el.label, elementType: el.tag, locatorStrategy: 'index', confidence: 'Low' };
    const entry = { elementLabel: el.label, elementType: el.tag, locatorStrategy: 'id', confidence: 'High' };
    if (wantX) entry.xpath = `//*[@id="${el.id}"]`;
    if (wantC) entry.cssSelector = `#${el.id}`;
    if (wantP) entry.playwrightLocator = `locator('#${el.id}')`;
    return entry;
  });
};

const analyzeRouter = require('../routes/analyze');
const { activeRuns } = require('../lib/sessionStore');

const TARGET_HTML = `<!doctype html><html><head><title>Test Form</title></head><body>
  <h1 id="heading">Sign Up</h1>
  <form>
    <input id="firstName" name="firstName" placeholder="First name"/>
    <input id="lastName" name="lastName" placeholder="Last name"/>
    <input id="email" type="email" name="email" placeholder="Email"/>
    <select id="country"><option>US</option><option>UK</option></select>
    <button id="submitBtn" type="button">Submit</button>
    <a id="homeLink" href="/home">Home</a>
  </form>
</body></html>`;

let appServer, targetServer, appPort, targetUrl;

function listen(server) {
  return new Promise(res => server.listen(0, () => res(server.address().port)));
}

// Collect SSE events for a run until the stream ends (or the timeout fires).
function collectSSE(port, runId) {
  const events = [];
  const done = new Promise(resolve => {
    const req = http.get(`http://localhost:${port}/api/analyze/progress?runId=${runId}`, r => {
      let buf = '';
      r.on('data', d => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data:'));
          if (line) { try { events.push(JSON.parse(line.slice(5).trim())); } catch (_) {} }
        }
      });
      r.on('end', resolve);
      r.on('error', resolve);
    });
    req.on('error', resolve);
  });
  return { events, done };
}

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`http://localhost:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, r => {
      let b = '';
      r.on('data', d => b += d);
      r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : {} }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getStatus(port, path) {
  return new Promise(resolve => {
    http.get(`http://localhost:${port}${path}`, r => { r.resume(); resolve(r.statusCode); }).on('error', () => resolve(0));
  });
}

before(async () => {
  if (SKIP) return;
  // Allow the localhost test target through the SSRF guard, restored in after().
  prevAllowPrivate = process.env.ALLOW_PRIVATE_TARGETS;
  process.env.ALLOW_PRIVATE_TARGETS = '1';

  targetServer = http.createServer((_req, r) => { r.setHeader('Content-Type', 'text/html'); r.end(TARGET_HTML); });
  const tport = await listen(targetServer);
  targetUrl = `http://localhost:${tport}/`;

  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', analyzeRouter);
  appServer = http.createServer(app);
  appPort = await listen(appServer);
});

after(() => {
  if (appServer) appServer.close();
  if (targetServer) targetServer.close();
  if (prevAllowPrivate === undefined) delete process.env.ALLOW_PRIVATE_TARGETS;
  else process.env.ALLOW_PRIVATE_TARGETS = prevAllowPrivate;
});

test('happy path: emits ordered SSE progress and returns verified locators + POM', { skip: SKIP, timeout: 90000 }, async () => {
  stubDelayMs = 0;
  const runId = 'run_itest_happy';
  const sse = collectSSE(appPort, runId);

  const res = await postJson(appPort, '/api/analyze', {
    url: targetUrl, mistralApiKey: 'dummy',
    locatorTypes: ['css', 'xpath', 'playwright'], generatePom: true, runId,
  });

  assert.equal(res.status, 200, 'analyze should return 200');
  assert.ok(res.body.totalVerified >= 5, `expected >=5 verified, got ${res.body.totalVerified}`);
  assert.ok(Array.isArray(res.body.locators) && res.body.locators.length >= 5, 'locators array populated');
  assert.equal(res.body.totalExtracted >= res.body.totalVerified, true, 'extracted >= verified');
  assert.ok(typeof res.body.pom === 'string' && res.body.pom.length > 20, 'POM generated');

  await Promise.race([sse.done, new Promise(r => setTimeout(r, 2000))]);
  const keys = sse.events.map(e => e.key);
  for (const k of ['p1', 'p2', 'p3', 'p4', 'p5']) {
    assert.ok(keys.includes(k), `SSE should include a ${k} event`);
  }
  const end = sse.events.find(e => e.key === 'end');
  assert.ok(end && end.state === 'done', 'SSE should end with state=done');

  // p1..p5 must each reach a terminal state, in order.
  const order = ['p1', 'p2', 'p3', 'p4', 'p5'];
  let lastIdx = -1;
  for (const ev of sse.events) {
    const idx = order.indexOf(ev.key);
    if (idx >= 0) { assert.ok(idx >= lastIdx, `events out of order at ${ev.key}`); lastIdx = idx; }
  }
  assert.ok(!activeRuns.has(runId), 'run cleaned from registry after completion');
});

test('cancel: stops a slow run, returns {cancelled}, emits end:cancelled, cleans registry', { skip: SKIP, timeout: 60000 }, async () => {
  stubDelayMs = 2000; // hold in the Mistral (p3) stage long enough to cancel
  const runId = 'run_itest_cancel';
  const sse = collectSSE(appPort, runId);

  const analyzeP = postJson(appPort, '/api/analyze', {
    url: targetUrl, mistralApiKey: 'dummy', locatorTypes: ['css'], generatePom: false, runId,
  });

  await new Promise(r => setTimeout(r, 900)); // let it get past fetch into p3
  const cancelResp = await postJson(appPort, '/api/analyze/cancel', { runId });
  assert.equal(cancelResp.body.success, true, 'cancel returns success');

  const analyzeResp = await analyzeP;
  assert.equal(analyzeResp.body.cancelled, true, 'analyze reports cancelled');

  await Promise.race([sse.done, new Promise(r => setTimeout(r, 3000))]);
  const end = sse.events.find(e => e.key === 'end');
  assert.ok(end && end.state === 'cancelled', 'SSE emits end:cancelled');
  assert.ok(!activeRuns.has(runId), 'cancelled run cleaned from registry');
  stubDelayMs = 0;
});

test('validation: rejects a malformed runId', { skip: SKIP, timeout: 20000 }, async () => {
  const res = await postJson(appPort, '/api/analyze', {
    url: targetUrl, mistralApiKey: 'dummy', locatorTypes: ['css'], runId: 'bad id!',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Invalid runId/);
});

test('validation: SSE endpoint rejects a malformed runId with 400', { skip: SKIP, timeout: 20000 }, async () => {
  const code = await getStatus(appPort, '/api/analyze/progress?runId=bad%20id');
  assert.equal(code, 400);
});

test('cancel: unknown runId is treated as success (idempotent)', { skip: SKIP, timeout: 20000 }, async () => {
  const res = await postJson(appPort, '/api/analyze/cancel', { runId: 'never_existed' });
  assert.equal(res.body.success, true);
});
