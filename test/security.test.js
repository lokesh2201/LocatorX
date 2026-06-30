const { test } = require('node:test');
const assert = require('node:assert');
const { assertSafeUrl, isPrivateIPv4, isPrivateIPv6 } = require('../lib/security');

test('isPrivateIPv4 identifies private/loopback/link-local ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254']) {
    assert.equal(isPrivateIPv4(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1']) {
    assert.equal(isPrivateIPv4(ip), false, ip);
  }
});

test('isPrivateIPv6 identifies loopback/ULA/link-local/mapped ranges', () => {
  for (const ip of ['::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateIPv6(ip), true, ip);
  }
  assert.equal(isPrivateIPv6('2606:4700::1111'), false);
});

test('assertSafeUrl rejects non-http(s) schemes', async () => {
  await assert.rejects(() => assertSafeUrl('file:///etc/passwd'), /scheme/);
  await assert.rejects(() => assertSafeUrl('ftp://example.com'), /scheme/);
});

test('assertSafeUrl rejects invalid URLs', async () => {
  await assert.rejects(() => assertSafeUrl('not a url'), /Invalid URL/);
});

test('assertSafeUrl blocks literal private IPs and cloud metadata', async () => {
  await assert.rejects(() => assertSafeUrl('http://169.254.169.254/latest/meta-data/'), /private\/internal/);
  await assert.rejects(() => assertSafeUrl('http://127.0.0.1:8080/'), /private\/internal/);
  await assert.rejects(() => assertSafeUrl('http://localhost/'), /localhost/);
});

test('assertSafeUrl honors ALLOW_PRIVATE_TARGETS override', async () => {
  process.env.ALLOW_PRIVATE_TARGETS = '1';
  try {
    const parsed = await assertSafeUrl('http://127.0.0.1:3000/');
    assert.equal(parsed.hostname, '127.0.0.1');
  } finally {
    delete process.env.ALLOW_PRIVATE_TARGETS;
  }
});
