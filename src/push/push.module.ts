import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AppConfigService } from '../config/app-config.service.js';
import { PUSH_JOB_PROCESSOR } from '../queue/push-jobs.js';
import { vapidDetails } from './push-config.js';
import { PUSH_SENDER, type PushSender, WebPushSender } from './push-sender.js';
import { PushSubscriptionsService } from './push-subscriptions.service.js';
import { PushController } from './push.controller.js';
import { PushService } from './push.service.js';

/** Never used: PushService skips every job while push is off. */
const OFF_SENDER: PushSender = {
  send: () => Promise.resolve({ kind: 'failed', statusCode: null }),
};

/** Web Push to the inbox people: subscriptions and the push jobs. */
@Module({
  imports: [AuthModule],
  controllers: [PushController],
  providers: [
    PushService,
    PushSubscriptionsService,
    { provide: PUSH_JOB_PROCESSOR, useExisting: PushService },
    {
      provide: PUSH_SENDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): PushSender => {
        const vapid = vapidDetails(config);
        return vapid ? new WebPushSender(vapid) : OFF_SENDER;
      },
    },
  ],
  exports: [PUSH_JOB_PROCESSOR],
})
export class PushModule {}
