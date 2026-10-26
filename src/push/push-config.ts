import type { AppConfigService } from '../config/app-config.service.js';

export interface VapidDetails {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * The VAPID keys, or null when Web Push is off (none set; the env schema
 * refuses to start with only some of them).
 */
export function vapidDetails(config: AppConfigService): VapidDetails | null {
  const publicKey = config.get('VAPID_PUBLIC_KEY');
  const privateKey = config.get('VAPID_PRIVATE_KEY');
  const subject = config.get('VAPID_SUBJECT');
  return publicKey && privateKey && subject
    ? { publicKey, privateKey, subject }
    : null;
}
