import { pollDelayMs } from './poll-delay.js';

const now = new Date('2026-10-24T12:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);
const base = {
  now,
  pollIntervalMs: 1_000,
  idlePollIntervalMs: 600_000,
};

describe('pollDelayMs', () => {
  it('keeps the regular pace while busy', () => {
    expect(pollDelayMs({ ...base, busy: true, nextRunnableAt: null })).toBe(
      1_000,
    );
  });

  it('sleeps the idle interval when nothing is pending', () => {
    expect(pollDelayMs({ ...base, busy: false, nextRunnableAt: null })).toBe(
      600_000,
    );
  });

  it('wakes up when a retry is due before the idle interval', () => {
    expect(
      pollDelayMs({ ...base, busy: false, nextRunnableAt: at(45_000) }),
    ).toBe(45_000);
  });

  it('caps a far-away retry at the idle interval', () => {
    expect(
      pollDelayMs({ ...base, busy: false, nextRunnableAt: at(3_600_000) }),
    ).toBe(600_000);
  });

  it('never polls faster than the regular pace for due or overdue jobs', () => {
    expect(
      pollDelayMs({ ...base, busy: false, nextRunnableAt: at(-5_000) }),
    ).toBe(1_000);
    expect(pollDelayMs({ ...base, busy: false, nextRunnableAt: at(200) })).toBe(
      1_000,
    );
  });

  it('never sleeps less than the regular pace when idle is configured lower', () => {
    expect(
      pollDelayMs({
        ...base,
        idlePollIntervalMs: 500,
        busy: false,
        nextRunnableAt: null,
      }),
    ).toBe(1_000);
  });
});
