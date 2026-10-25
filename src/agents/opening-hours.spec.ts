import { isOpenAt, localDay } from './opening-hours.js';

const BA = 'America/Argentina/Buenos_Aires';
const weekdays = {
  mon: ['09:00-18:00'],
  tue: ['09:00-18:00'],
  wed: ['09:00-13:00', '15:00-19:00'],
  thu: ['09:00-18:00'],
  fri: ['09:00-18:00'],
};
// 2026-10-26 is a Monday. Buenos Aires is UTC-3.
const at = (iso: string) => new Date(iso);

describe('isOpenAt', () => {
  it.each([
    ['Monday 09:00 local (opens)', '2026-10-26T12:00:00Z', true],
    ['Monday 17:59 local', '2026-10-26T20:59:00Z', true],
    ['Monday 18:00 local (closes)', '2026-10-26T21:00:00Z', false],
    ['Monday 08:59 local', '2026-10-26T11:59:00Z', false],
    ['Wednesday 14:00 local (between ranges)', '2026-10-28T17:00:00Z', false],
    ['Wednesday 15:30 local (second range)', '2026-10-28T18:30:00Z', true],
    ['Saturday noon (no hours that day)', '2026-10-31T15:00:00Z', false],
    // 01:00 UTC Tuesday is still Monday 22:00 in Buenos Aires.
    [
      'Monday 22:00 local, already Tuesday in UTC',
      '2026-10-27T01:00:00Z',
      false,
    ],
  ])('%s', (_label, iso, open) => {
    expect(isOpenAt(weekdays, BA, at(iso))).toBe(open);
  });

  it('uses the business timezone', () => {
    // In UTC, 12:00 is opening time and 18:30 is after closing.
    expect(isOpenAt(weekdays, 'UTC', at('2026-10-26T12:00:00Z'))).toBe(true);
    expect(isOpenAt(weekdays, 'UTC', at('2026-10-26T18:30:00Z'))).toBe(false);
  });
});

describe('localDay', () => {
  it('is the calendar day in the business timezone', () => {
    expect(localDay(BA, at('2026-10-27T01:00:00Z'))).toBe('2026-10-26');
    expect(localDay('UTC', at('2026-10-27T01:00:00Z'))).toBe('2026-10-27');
  });
});
