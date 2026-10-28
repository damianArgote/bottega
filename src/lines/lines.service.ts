import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** What the webhook needs to verify and route a delivery for a line. */
export interface WebhookLine {
  id: string;
  businessId: string;
  /** Null for a draft line (being onboarded, no number yet). */
  phoneNumberId: string | null;
  active: boolean;
  verifyToken: string;
  appSecretEncrypted: string | null;
}

const webhookLineSelect = {
  id: true,
  businessId: true,
  phoneNumberId: true,
  active: true,
  verifyToken: true,
  appSecretEncrypted: true,
} as const;

/** Read access to lines. Never returns decrypted secrets. */
@Injectable()
export class LinesService {
  constructor(private readonly prisma: PrismaService) {}

  findByWebhookKey(webhookKey: string): Promise<WebhookLine | null> {
    return this.prisma.line.findUnique({
      where: { webhookKey },
      select: webhookLineSelect,
    });
  }

  findById(id: string): Promise<WebhookLine | null> {
    return this.prisma.line.findUnique({
      where: { id },
      select: webhookLineSelect,
    });
  }

  findByPhoneNumberId(phoneNumberId: string): Promise<WebhookLine | null> {
    return this.prisma.line.findUnique({
      where: { phoneNumberId },
      select: webhookLineSelect,
    });
  }
}
