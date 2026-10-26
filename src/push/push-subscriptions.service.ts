import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

/** The browsers where each inbox person gets pushes. */
@Injectable()
export class PushSubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Saves the browser for the user, or updates it by endpoint (new keys, or
   * another person now signed in on that browser).
   */
  async save(userId: string, input: SubscriptionInput): Promise<void> {
    const data = {
      userId,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent ?? null,
    };
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: { endpoint: input.endpoint, ...data },
      update: data,
    });
  }

  /** Deletes the user's browser; nothing if it is not theirs or not known. */
  async remove(userId: string, endpoint: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
  }
}
