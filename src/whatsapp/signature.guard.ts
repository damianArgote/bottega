import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  type RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppConfigService } from '../config/app-config.service.js';
import { isValidSignature } from './signature.js';

export const SIGNATURE_HEADER = 'x-hub-signature-256';

/**
 * Rejects webhook deliveries whose `X-Hub-Signature-256` does not match the
 * raw body. Requires the app to be created with `rawBody: true`.
 */
@Injectable()
export class WhatsAppSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WhatsAppSignatureGuard.name);

  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<RawBodyRequest<Request>>();
    const header = request.headers[SIGNATURE_HEADER];
    const valid = isValidSignature(
      request.rawBody,
      typeof header === 'string' ? header : undefined,
      this.config.get('META_APP_SECRET'),
    );
    if (!valid) {
      this.logger.warn('Rejected webhook delivery with an invalid signature');
      throw new UnauthorizedException();
    }
    return true;
  }
}
