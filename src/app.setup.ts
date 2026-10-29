import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { CSV_MAX_BYTES } from './catalog/catalog.schemas.js';
import type { AppConfigService } from './config/app-config.service.js';

/**
 * HTTP setup shared by main.ts and the HTTP tests:
 * - cookies are parsed (inbox sessions);
 * - CORS allows only INBOX_ORIGIN, with credentials (the session cookies);
 * - one proxy hop is trusted (Render), so `req.ip` is the client's address
 *   for the login attempt limit;
 * - `text/csv` bodies (catalog imports, up to 2 MB) are read as text.
 */
export function configureHttp(
  app: INestApplication,
  config: AppConfigService,
): void {
  (app as NestExpressApplication).set('trust proxy', 1);
  (app as NestExpressApplication).useBodyParser('text', {
    type: 'text/csv',
    limit: CSV_MAX_BYTES,
  });
  app.use(cookieParser());
  const inboxOrigin = config.get('INBOX_ORIGIN');
  // Exact match: other origins get no CORS headers at all.
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => callback(null, origin === inboxOrigin),
    credentials: true,
  });
}
