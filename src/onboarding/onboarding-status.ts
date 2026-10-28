/** Where a line is in its onboarding, derived from what is stored. */
export type OnboardingStep = 'draft' | 'credentials' | 'registered';

/** What is still missing for a line to work, in the order it is done. */
export type PendingStep =
  'credentials' | 'number' | 'subscription' | 'app_published' | 'first_message';

export function onboardingStep(line: {
  accessTokenEncrypted: string | null;
  phoneNumberId: string | null;
}): OnboardingStep {
  if (line.phoneNumberId) {
    return 'registered';
  }
  return line.accessTokenEncrypted ? 'credentials' : 'draft';
}

/**
 * `appSubscribed` is null when Meta could not be asked (no credentials yet,
 * or Meta failed): the subscription is pending until Meta confirms it.
 */
export function pendingSteps(state: {
  step: OnboardingStep;
  appSubscribed: boolean | null;
  appPublishedAt: Date | null;
  lastInboundAt: Date | null;
}): PendingStep[] {
  const pending: PendingStep[] = [];
  if (state.step === 'draft') {
    pending.push('credentials');
  }
  if (state.step !== 'registered') {
    pending.push('number');
  }
  if (state.appSubscribed !== true) {
    pending.push('subscription');
  }
  if (!state.appPublishedAt) {
    pending.push('app_published');
  }
  if (!state.lastInboundAt) {
    pending.push('first_message');
  }
  return pending;
}
