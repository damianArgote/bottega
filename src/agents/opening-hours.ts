import { z } from 'zod';

export const WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const RANGE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

const minutes = (hhmm: string) =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** "HH:MM-HH:MM", start before end, within one day. */
const rangeSchema = z
  .string()
  .regex(RANGE, 'must be HH:MM-HH:MM')
  .refine((r) => minutes(r.slice(0, 5)) < minutes(r.slice(6)), {
    message: 'must end after it starts',
  });

/**
 * Opening hours by weekday, in the business timezone (Business.timezone).
 * A missing day is closed.
 */
export const openingHoursSchema = z
  .object(
    Object.fromEntries(
      WEEKDAYS.map((day) => [
        day,
        z.array(rangeSchema).min(1).max(4).optional(),
      ]),
    ) as Record<Weekday, z.ZodOptional<z.ZodArray<typeof rangeSchema>>>,
  )
  .strict();

export type OpeningHours = z.infer<typeof openingHoursSchema>;

const WEEKDAY_BY_NAME: Record<string, Weekday> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

/** Weekday and minutes since midnight of `now` in `timeZone`. Throws RangeError on an unknown zone. */
function localTime(
  timeZone: string,
  now: Date,
): { day: Weekday; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    day: WEEKDAY_BY_NAME[part('weekday')] ?? 'mon',
    minute: Number(part('hour')) * 60 + Number(part('minute')),
  };
}

/** True when `now` falls in one of the day's ranges (start included, end excluded). */
export function isOpenAt(
  hours: OpeningHours,
  timeZone: string,
  now: Date,
): boolean {
  const { day, minute } = localTime(timeZone, now);
  return (hours[day] ?? []).some(
    (r) => minutes(r.slice(0, 5)) <= minute && minute < minutes(r.slice(6)),
  );
}

/** Calendar day of `now` in `timeZone`, as YYYY-MM-DD. */
export function localDay(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
