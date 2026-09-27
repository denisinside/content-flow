import { ForbiddenException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthConfig } from './auth-config.js';
import { opaqueToken, tokenDigest, validOpaqueToken } from './session-crypto.js';

export const SESSION_COOKIE = '__Host-contextflow';
export const CSRF_COOKIE = '__Host-contextflow-csrf';
const CSRF_TTL_MS = 3_600_000;

export function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const matches = (request.headers.cookie ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith(name + '='));
  if (matches.length !== 1) return undefined;
  return matches[0]?.slice(name.length + 1);
}

export function setCookie(response: ServerResponse, name: string, value: string, maxAge: number): void {
  const existing = response.getHeader('Set-Cookie');
  const cookies = Array.isArray(existing) ? existing.map(String) : existing ? [String(existing)] : [];
  response.setHeader('Set-Cookie', [...cookies, `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`]);
}

export class CsrfProtection {
  constructor(private readonly config: AuthConfig) {}
  private mac(nonce: string, timestamp: string, session: string | undefined): string {
    return createHmac('sha256', this.config.csrfKey).update(`csrf:${nonce}:${timestamp}:${validOpaqueToken(session) ? tokenDigest(session) : ''}`).digest('base64url');
  }
  private read(value: string | undefined, session: string | undefined): string | null {
    if (!value) return null;
    const parts = value.split('.');
    const [nonce, timestamp, mac] = parts;
    if (parts.length !== 3 || !validOpaqueToken(nonce) || !timestamp || !/^\d{13}$/.test(timestamp) || !validOpaqueToken(mac)) return null;
    const age = Date.now() - Number(timestamp);
    if (age < 0 || age >= (validOpaqueToken(session) ? this.config.absoluteTtlMs : CSRF_TTL_MS)) return null;
    return timingSafeEqual(Buffer.from(mac), Buffer.from(this.mac(nonce, timestamp, session))) ? nonce : null;
  }
  token(request: IncomingMessage, response: ServerResponse, session: string | undefined, rotate = false): string {
    const current = !rotate ? this.read(cookieValue(request, CSRF_COOKIE), session) : null;
    if (current) return current;
    const nonce = opaqueToken();
    const timestamp = String(Date.now());
    setCookie(response, CSRF_COOKIE, `${nonce}.${timestamp}.${this.mac(nonce, timestamp, session)}`, (validOpaqueToken(session) ? this.config.absoluteTtlMs : CSRF_TTL_MS) / 1000);
    return nonce;
  }
  require(request: IncomingMessage): void {
    const nonce = this.read(cookieValue(request, CSRF_COOKIE), cookieValue(request, SESSION_COOKIE));
    const supplied = request.headers['x-csrf-token'];
    if (request.headers.origin !== this.config.webOrigin || !nonce || typeof supplied !== 'string'
      || !validOpaqueToken(supplied) || !timingSafeEqual(Buffer.from(nonce), Buffer.from(supplied))) {
      throw new ForbiddenException('Request verification failed');
    }
  }
}
