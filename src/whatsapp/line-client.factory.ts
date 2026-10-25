import { Injectable, Logger } from '@nestjs/common';
import { CredentialsDecryptError } from '../lines/credentials-cipher.js';
import { LineCredentialsService } from '../lines/line-credentials.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GraphWhatsAppClient } from './graph-whatsapp.client.js';
import type {
  SendOutcome,
  WhatsAppClient,
  WhatsAppClientFactory,
} from './whatsapp.client.js';

/** Sends nothing: every message is rejected as not retryable. */
function unavailableClient(message: string): WhatsAppClient {
  const outcome: SendOutcome = {
    kind: 'rejected',
    code: 'line_credentials_unavailable',
    httpStatus: null,
    message,
    retryable: false,
  };
  return { sendText: () => Promise.resolve(outcome) };
}

/**
 * Builds a client bound to a line: its phone number id and its decrypted
 * System User token. A conversation without a usable line gets a client
 * that rejects every send (never retried, so the failure is visible).
 */
@Injectable()
export class LineWhatsAppClientFactory implements WhatsAppClientFactory {
  private readonly logger = new Logger(LineWhatsAppClientFactory.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: LineCredentialsService,
    private readonly graph: GraphWhatsAppClient,
  ) {}

  async forLine(lineId: string | null): Promise<WhatsAppClient> {
    if (!lineId) {
      return unavailableClient('conversation has no line');
    }
    const line = await this.prisma.line.findUnique({
      where: { id: lineId },
      select: { phoneNumberId: true, accessTokenEncrypted: true },
    });
    if (!line?.accessTokenEncrypted) {
      this.logger.warn(`Line ${lineId} has no access token: sends rejected`);
      return unavailableClient('line has no access token');
    }
    let accessToken: string;
    try {
      accessToken = this.credentials.decrypt(line.accessTokenEncrypted);
    } catch (error) {
      if (!(error instanceof CredentialsDecryptError)) {
        throw error;
      }
      this.logger.warn(
        `Line ${lineId} access token cannot be decrypted (TOKEN_ENCRYPTION_KEY changed?): sends rejected`,
      );
      return unavailableClient('line access token cannot be decrypted');
    }
    const credentials = { phoneNumberId: line.phoneNumberId, accessToken };
    return {
      sendText: (to, body) => this.graph.sendText(credentials, to, body),
    };
  }
}
