const dns = require('dns').promises;
const net = require('net');

// ─── SSRF GUARD ───────────────────────────────────────────────────────────────
// The server fetches whatever URL a client supplies (via Playwright). Without
// validation a caller could point it at internal services or the cloud metadata
// endpoint (169.254.169.254). assertSafeUrl() enforces http/https and refuses
// private / loopback / link-local destinations.
//
// Testing a locally-hosted app is a legitimate use of this tool, so private
// targets can be re-enabled by setting ALLOW_PRIVATE_TARGETS=1 in the env.

function unsafeUrlError(message, status = 400) {
  const err = new Error(message);
  err.code = 'UNSAFE_URL';
  err.status = status;
  return err;
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

// True for any IPv4 address in a private / loopback / link-local / reserved range.
function isPrivateIPv4(ip) {
  const n = ipv4ToInt(ip);
  const inRange = (base, bits) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  };
  return inRange('0.0.0.0', 8)      || // "this" network / unspecified
         inRange('10.0.0.0', 8)     || // private
         inRange('100.64.0.0', 10)  || // carrier-grade NAT
         inRange('127.0.0.0', 8)    || // loopback
         inRange('169.254.0.0', 16) || // link-local (incl. cloud metadata)
         inRange('172.16.0.0', 12)  || // private
         inRange('192.168.0.0', 16) || // private
         inRange('192.0.0.0', 24)   || // IETF protocol assignments
         inRange('192.0.2.0', 24)   || // TEST-NET-1
         inRange('255.255.255.255', 32); // broadcast
}

function isPrivateIPv6(ip) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::1' || s === '::') return true;          // loopback / unspecified
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isPrivateIPv4(mapped[1]);
  const head = s.split(':')[0];
  if (/^f[cd]/.test(head)) return true;                // fc00::/7 unique-local
  if (/^fe[89ab]/.test(head)) return true;             // fe80::/10 link-local
  return false;
}

function isPrivateAddress(address, family) {
  return family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address);
}

// Validates a URL and (unless private targets are allowed) ensures every address
// the host resolves to is public. Returns the parsed URL on success, throws an
// error carrying `.status` and `.code` on failure.
async function assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw unsafeUrlError('Invalid URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw unsafeUrlError(`Unsupported URL scheme "${parsed.protocol}" — only http and https are allowed.`);
  }

  if (process.env.ALLOW_PRIVATE_TARGETS === '1') return parsed;

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(host);

  let addresses;
  if (literalFamily) {
    addresses = [{ address: host, family: literalFamily }];
  } else {
    if (host.toLowerCase() === 'localhost') {
      throw unsafeUrlError('Refusing to access localhost. Set ALLOW_PRIVATE_TARGETS=1 to allow local targets.', 403);
    }
    try {
      addresses = await dns.lookup(host, { all: true });
    } catch (_) {
      throw unsafeUrlError(`Could not resolve host "${host}".`);
    }
  }

  for (const { address, family } of addresses) {
    if (isPrivateAddress(address, family)) {
      throw unsafeUrlError(
        `Refusing to access private/internal address (${address}). ` +
        `Set ALLOW_PRIVATE_TARGETS=1 to allow local targets.`,
        403,
      );
    }
  }

  return parsed;
}

module.exports = { assertSafeUrl, isPrivateIPv4, isPrivateIPv6 };
