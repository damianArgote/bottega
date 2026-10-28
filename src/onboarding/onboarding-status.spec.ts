import { onboardingStep, pendingSteps } from './onboarding-status.js';

const draft = {
  accessTokenEncrypted: null,
  phoneNumberId: null,
  appPublishedAt: null,
};

describe('onboardingStep', () => {
  it('follows the stored data: draft, credentials, registered', () => {
    expect(onboardingStep(draft)).toBe('draft');
    expect(onboardingStep({ ...draft, accessTokenEncrypted: 'x' })).toBe(
      'credentials',
    );
    expect(
      onboardingStep({
        ...draft,
        accessTokenEncrypted: 'x',
        phoneNumberId: '700',
      }),
    ).toBe('registered');
  });
});

describe('pendingSteps', () => {
  const done = {
    step: 'registered' as const,
    appSubscribed: true,
    appPublishedAt: new Date(),
    lastInboundAt: new Date(),
  };

  it('is empty when everything is done', () => {
    expect(pendingSteps(done)).toEqual([]);
  });

  it('lists what a draft still needs, in order', () => {
    expect(
      pendingSteps({
        step: 'draft',
        appSubscribed: null,
        appPublishedAt: null,
        lastInboundAt: null,
      }),
    ).toEqual([
      'credentials',
      'number',
      'subscription',
      'app_published',
      'first_message',
    ]);
  });

  it('keeps publishing the app pending until the team confirms it', () => {
    expect(pendingSteps({ ...done, appPublishedAt: null })).toEqual([
      'app_published',
    ]);
  });

  it('counts the subscription as pending when Meta says no or could not tell', () => {
    expect(pendingSteps({ ...done, appSubscribed: false })).toEqual([
      'subscription',
    ]);
    expect(pendingSteps({ ...done, appSubscribed: null })).toEqual([
      'subscription',
    ]);
  });
});
