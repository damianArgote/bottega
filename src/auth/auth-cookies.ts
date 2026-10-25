import type { CookieOptions, Response } from 'express';
import { REFRESH_TTL_SECONDS, SESSION_TTL_SECONDS } from './session-tokens.js';

export const SESSION_COOKIE = 'bottega_session';
export const REFRESH_COOKIE = 'bottega_refresh';

const base: CookieOptions = { httpOnly: true, secure: true, sameSite: 'lax' };
/** The refresh token only travels to /auth (refresh and logout). */
const sessionOptions: CookieOptions = { ...base, path: '/' };
const refreshOptions: CookieOptions = { ...base, path: '/auth' };

export function setAuthCookies(
  res: Response,
  tokens: { session: string; refresh: string },
): void {
  res.cookie(SESSION_COOKIE, tokens.session, {
    ...sessionOptions,
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE, tokens.refresh, {
    ...refreshOptions,
    maxAge: REFRESH_TTL_SECONDS * 1000,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(SESSION_COOKIE, sessionOptions);
  res.clearCookie(REFRESH_COOKIE, refreshOptions);
}

/** A cookie value from cookie-parser, or undefined. */
export function readCookie(cookies: unknown, name: string): string | undefined {
  const value = (cookies as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value ? value : undefined;
}
