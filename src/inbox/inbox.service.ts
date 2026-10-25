import { Injectable } from '@nestjs/common';
import type { BusinessAccess } from '../auth/business-access.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class InboxService {
  constructor(private readonly prisma: PrismaService) {}

  async business(access: BusinessAccess) {
    const business = await this.prisma.business.findUniqueOrThrow({
      where: { id: access.businessId },
      select: { id: true, name: true, slug: true },
    });
    return { business, role: access.role };
  }
}
