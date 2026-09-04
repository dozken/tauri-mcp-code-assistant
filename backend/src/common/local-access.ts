import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config/configuration.js';

/**
 * Access policy for a service that binds to loopback and reads local files.
 *
 * The threat is not the internet — it is the machine. Two attackers can reach
 * `127.0.0.1:3001` without any network access at all:
 *
 * 1. **Any web page the user has open.** CORS stops a page *reading* our response,
 *    but not *sending* the request: a `fetch` with `Content-Type: text/plain` is a
 *    "simple request" and skips the preflight entirely. So a page could fire
 *    `POST /index` all day. What a page *cannot* do is forge `Origin` — the browser
 *    sets it — so checking `Origin` server-side, rather than only echoing CORS
 *    headers back, is what actually closes this.
 *
 * 2. **Any other local process.** It can send whatever headers it likes, including
 *    an allowed `Origin`. Nothing in a header can distinguish it, so requests that
 *    arrive without a browser's `Origin` must carry the bearer token instead.
 *
 * Hence: an allowed `Origin` proves "a browser, on a page we trust". No `Origin`
 * means "not a browser", which must prove itself with the token. And `Host` must
 * be loopback, or a DNS-rebinding attacker resolves their own domain to
 * 127.0.0.1 and arrives with an `Origin` that is, from their point of view, valid.
 */

export interface AccessRequest {
  readonly origin?: string;
  readonly host?: string;
  readonly authorization?: string;
}

export type AccessDecision =
  | { readonly allowed: true; readonly via: 'disabled' | 'origin' | 'token' }
  | { readonly allowed: false; readonly reason: string };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Strips the port so `127.0.0.1:3001` and `127.0.0.1` compare equal.
 *
 * A colon only separates a port when the host is a name or an IPv4 address; an
 * IPv6 literal is full of them, and carries a port only when bracketed.
 */
const hostnameOf = (host: string): string => {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) return trimmed.slice(0, trimmed.indexOf(']') + 1);
  const colon = trimmed.indexOf(':');
  if (colon === -1) return trimmed;
  // More than one colon and no brackets: a bare IPv6 literal, so there is no port.
  return trimmed.includes(':', colon + 1) ? trimmed : trimmed.slice(0, colon);
};

/** Constant-time compare, so a wrong token cannot be found one byte at a time. */
export const tokenMatches = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // `timingSafeEqual` throws on a length mismatch, which would leak the length.
  return a.length === b.length && timingSafeEqual(a, b);
};

const bearerOf = (authorization: string | undefined): string | undefined => {
  if (authorization === undefined) return undefined;
  const [scheme, ...rest] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' && rest.length > 0 ? rest.join(' ') : undefined;
};

export const decideAccess = (request: AccessRequest, config: AppConfig): AccessDecision => {
  if (!config.auth.enabled) return { allowed: true, via: 'disabled' };

  // A DNS-rebinding attacker arrives with their own hostname in `Host`.
  if (request.host !== undefined && !LOOPBACK_HOSTS.has(hostnameOf(request.host))) {
    return { allowed: false, reason: `Host "${request.host}" is not loopback` };
  }

  const token = bearerOf(request.authorization);
  if (token !== undefined && tokenMatches(token, config.auth.token)) {
    return { allowed: true, via: 'token' };
  }

  if (request.origin !== undefined) {
    return config.corsOrigins.includes(request.origin)
      ? { allowed: true, via: 'origin' }
      : { allowed: false, reason: `Origin "${request.origin}" is not allowed` };
  }

  return {
    allowed: false,
    reason: 'No Origin header, so this is not a browser: send Authorization: Bearer <token>',
  };
};
