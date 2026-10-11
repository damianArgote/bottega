import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppConfigService } from '../config/app-config.service.js';

export const ADMIN_API_KEY_HEADER = 'x-admin-api-key';

/**
 * Accepts `X-Admin-Api-Key: <key>` or `Authorization: Bearer <key>`.
 * Both sides are hashed before the constant-time comparison, so neither the
 * content nor the length of the configured key leaks through timing.
 * The provided key is never logged.
 */
@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(AdminApiKeyGuard.name);

  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = extractKey(request);
    if (!provided || !matches(provided, this.config.get('ADMIN_API_KEY'))) {
      this.logger.warn(
        `Rejected admin request (${provided ? 'invalid' : 'missing'} API key): ${request.method} ${request.path}`,
      );
      throw new UnauthorizedException('Missing or invalid admin API key');
    }
    return true;
  }
}

function extractKey(request: Request): string | undefined {
  const header = request.headers[ADMIN_API_KEY_HEADER];
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }
  const authorization = request.headers.authorization;
  const match = authorization?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}

function matches(provided: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}
