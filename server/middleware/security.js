import net from 'node:net';
import dns from 'node:dns/promises';

const MAX_URL_LENGTH = 2048;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Check if an IP address belongs to loopback, private, link-local, or cloud metadata ranges
 */
export function isForbiddenIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
      return true;
    }
    const [a, b] = parts;
    // 0.0.0.0/8 (current network)
    if (a === 0) return true;
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 10.0.0.0/8 (RFC1918 private)
    if (a === 10) return true;
    // 172.16.0.0/12 (RFC1918 private)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 (RFC1918 private)
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (link-local, cloud metadata e.g. AWS/GCP 169.254.169.254)
    if (a === 169 && b === 254) return true;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    // ::1 (IPv6 loopback)
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
    // :: (unspecified)
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
    // IPv4-mapped IPv6 (::ffff:127.0.0.1)
    if (normalized.startsWith('::ffff:')) {
      const v4 = normalized.substring(7);
      return isForbiddenIp(v4);
    }
    // fe80::/10 (link-local)
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
      return true;
    }
    // fc00::/7 (unique local address)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
      return true;
    }
    return false;
  }

  return true;
}

/**
 * Server-side strict URL validation and SSRF prevention
 */
export async function validateDestinationUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return { isValid: false, error: 'URL is required and must be a string' };
  }

  const trimmed = urlString.trim();

  // 1. Length restriction
  if (trimmed.length > MAX_URL_LENGTH) {
    return { isValid: false, error: `URL exceeds maximum allowable length of ${MAX_URL_LENGTH} characters` };
  }

  // 2. Syntax & protocol parsing
  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch (err) {
    return { isValid: false, error: 'Malformed or invalid URL syntax' };
  }

  // 3. Scheme check (only http/https)
  if (!ALLOWED_PROTOCOLS.has(parsedUrl.protocol)) {
    return { isValid: false, error: `Unsupported protocol '${parsedUrl.protocol}'. Only HTTP and HTTPS are permitted` };
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  // 4. Reject localhost, local domain suffixes
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === '0.0.0.0'
  ) {
    return { isValid: false, error: 'Destination cannot be localhost or a local/internal domain' };
  }

  // 5. Direct IP check
  if (net.isIP(hostname)) {
    if (isForbiddenIp(hostname)) {
      return { isValid: false, error: `Destination IP address (${hostname}) is private, loopback, or cloud-metadata` };
    }
    return { isValid: true, sanitizedUrl: parsedUrl.toString() };
  }

  // 6. DNS resolution check (SSRF protection)
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      return { isValid: false, error: `Host '${hostname}' does not resolve to any IP address` };
    }

    for (const record of addresses) {
      if (isForbiddenIp(record.address)) {
        return {
          isValid: false,
          error: `Destination host '${hostname}' resolves to forbidden private or loopback IP (${record.address})`
        };
      }
    }
  } catch (err) {
    return { isValid: false, error: `Failed to resolve destination hostname '${hostname}': ${err.message}` };
  }

  return { isValid: true, sanitizedUrl: parsedUrl.toString() };
}
