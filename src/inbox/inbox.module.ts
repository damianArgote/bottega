import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BusinessAccessGuard } from '../auth/business-access.guard.js';
import { InboxController } from './inbox.controller.js';
import { InboxService } from './inbox.service.js';

@Module({
  imports: [AuthModule],
  controllers: [InboxController],
  providers: [InboxService, BusinessAccessGuard],
})
export class InboxModule {}
