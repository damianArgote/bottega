import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  NotFoundException,
  type RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { LineCredentialsService } from '../lines/line-credentials.service.js';
import { LinesService, type WebhookLine } from '../lines/lines.service.js';
import { SIGNATURE_HEADER } from './signature.guard.js';
import { isValidSignature } from './signature.js';

/** The verified line, attached to the request by {@link LineSignatureGuard}. */
export interface LineRequest extends RawBodyRequest<Request> {
  webhookLine?: WebhookLine;
}

/**
 * For `/webhooks/whatsapp/:webhookKey`: finds the line by its key (404 when
 * unknown or inactive, touching the database only for that lookup) and
 * checks `X-Hub-Signature-256` against that line's own app secret (401),
 * before anything is parsed or stored.
 */
@Injectable()
export class LineSignatureGuard implements CanActivate {
  private readonly logger = new Logger(LineSignatureGuard.name);

  constructor(
    private readonly lines: LinesService,
    private readonly credentials: LineCredentialsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<LineRequest>();
    const webhookKey = request.params['webhookKey'];
    const line =
      typeof webhookKey === 'string'
        ? await this.lines.findByWebhookKey(webhookKey)
        : null;
    if (!line || !line.active) {
      throw new NotFoundException();
    }
    const header = request.headers[SIGNATURE_HEADER];
    const valid =
      line.appSecretEncrypted !== null &&
      isValidSignature(
        request.rawBody,
        typeof header === 'string' ? header : undefined,
        this.credentials.decrypt(line.appSecretEncrypted),
      );
    if (!valid) {
      this.logger.warn(
        `Rejected webhook delivery for line ${line.id} with an invalid signature`,
      );
      throw new UnauthorizedException();
    }
    request.webhookLine = line;
    return true;
  }
}
