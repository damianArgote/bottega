import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashKey } from './integrations.service.js';

export const INTEGRATION_KEY_HEADER = 'x-api-key';

/** lastUsedAt is written at most this often per key. */
const LAST_USED_RESOLUTION_MS = 60_000;

type IntegrationRequest = Request & { integrationBusinessId?: string };

/**
 * Accepts `X-Api-Key: <key>` or `Authorization: Bearer <key>` with a
 * non-revoked integration key, looked up by its SHA-256 (the key is random
 * and long, so no timing comparison is needed). The request then belongs to
 * that key's business ({@link IntegrationBusiness}). The key is never
 * logged.
 */
@Injectable()
export class IntegrationKeyGuard implements CanActivate {
  private readonly logger = new Logger(IntegrationKeyGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IntegrationRequest>();
    const provided = extractKey(request);
    const key = provided
      ? await this.prisma.integrationKey.findUnique({
          where: { keyHash: hashKey(provided) },
          select: {
            id: true,
            businessId: true,
            revokedAt: true,
            lastUsedAt: true,
          },
        })
      : null;
    if (!key || key.revokedAt) {
      this.logger.warn(
        `Rejected integrations request (${provided ? 'invalid or revoked' : 'missing'} key): ${request.method} ${request.path}`,
      );
      throw new UnauthorizedException('Missing or invalid integration key');
    }
    if (
      !key.lastUsedAt ||
      Date.now() - key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS
    ) {
      await this.prisma.integrationKey.update({
        where: { id: key.id },
        data: { lastUsedAt: new Date() },
      });
    }
    request.integrationBusinessId = key.businessId;
    return true;
  }
}

/** The business of the integration key that authenticated the request. */
export const IntegrationBusiness = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const id = context
      .switchToHttp()
      .getRequest<IntegrationRequest>().integrationBusinessId;
    if (!id) {
      throw new UnauthorizedException('Missing integration key');
    }
    return id;
  },
);

function extractKey(request: Request): string | undefined {
  const header = request.headers[INTEGRATION_KEY_HEADER];
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }
  const match = request.headers.authorization?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}
