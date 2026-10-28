import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ContentValidationError,
  loadContent,
  parseContent,
} from './content.schema.js';
import { DEFAULT_CONTENT_DIR } from './content.service.js';

const aesthetics = () =>
  JSON.parse(
    readFileSync(join(DEFAULT_CONTENT_DIR, 'demos', 'aesthetics.json'), 'utf8'),
  ) as Record<string, unknown>;

const insurance = () =>
  JSON.parse(
    readFileSync(join(DEFAULT_CONTENT_DIR, 'demos', 'insurance.json'), 'utf8'),
  ) as Record<string, unknown>;

const first = (list: unknown) =>
  (list as Record<string, unknown>[])[0] as Record<string, unknown>;

const parse = (
  center: unknown,
  commercialInfo = '# Bottega\n\nInfo',
  insuranceDemo: unknown = insurance(),
) =>
  parseContent({
    commercialInfo,
    aesthetics: JSON.stringify(center),
    insurance: JSON.stringify(insuranceDemo),
  });

describe('content files', () => {
  it('loads the shipped content files', () => {
    const content = loadContent(DEFAULT_CONTENT_DIR);

    expect(content.aesthetics.fictitious).toBe(true);
    expect(content.aesthetics.services.length).toBeGreaterThan(0);
    expect(content.insurance.fictitious).toBe(true);
    expect(content.insurance.plans).toHaveLength(3);
    expect(content.commercialInfo).toContain('[COMPLETAR]');
    // Editing notes (HTML comment) are not passed to the bot.
    expect(content.commercialInfo).not.toContain('<!--');
  });

  it.each([
    [
      'a missing required field',
      (s: Record<string, unknown>) => delete s.name,
      'name',
    ],
    [
      'fictitious not true',
      (s: Record<string, unknown>) => (s.fictitious = false),
      'fictitious',
    ],
    [
      'no services',
      (s: Record<string, unknown>) => (s.services = []),
      'services',
    ],
    [
      'a negative price',
      (s: Record<string, unknown>) => (first(s.services).priceArs = -1),
      'services.0.priceArs',
    ],
    [
      'a booking link that is not a URL',
      (s: Record<string, unknown>) => (s.bookingUrl = 'agenda online'),
      'bookingUrl',
    ],
    ['an unknown key', (s: Record<string, unknown>) => (s.extra = 1), '(root)'],
  ])('rejects the aesthetics file with %s', (_label, mutate, path) => {
    const center = aesthetics();
    mutate(center);

    expect(() => parse(center)).toThrow(ContentValidationError);
    expect(() => parse(center)).toThrow(`${path}:`);
    expect(() => parse(center)).toThrow('demos/aesthetics.json');
  });

  it.each([
    [
      'more than three plans',
      (s: Record<string, unknown>) =>
        (s.plans = [...(s.plans as unknown[]), ...(s.plans as unknown[])]),
      'plans',
    ],
    [
      'an unknown vehicle category',
      (s: Record<string, unknown>) => (first(s.vehicles).category = 'Z'),
      'vehicles.0.category',
    ],
    [
      'a plan price missing a category',
      (s: Record<string, unknown>) => (first(s.plans).monthlyArs = { A: 1 }),
      'plans.0.monthlyArs.B',
    ],
  ])('rejects the insurance file with %s', (_label, mutate, path) => {
    const demo = insurance();
    mutate(demo);

    expect(() => parse(aesthetics(), undefined, demo)).toThrow(`${path}:`);
    expect(() => parse(aesthetics(), undefined, demo)).toThrow(
      'demos/insurance.json',
    );
  });

  it('rejects invalid JSON', () => {
    expect(() =>
      parseContent({
        commercialInfo: 'x',
        aesthetics: '{ nope',
        insurance: JSON.stringify(insurance()),
      }),
    ).toThrow('is not valid JSON');
  });

  it('rejects a commercial info file with only comments', () => {
    expect(() => parse(aesthetics(), '<!-- notes -->\n  \n')).toThrow(
      'commercial-info.md',
    );
  });

  it('reports a missing directory naming the file', () => {
    expect(() => loadContent('/nonexistent-content-dir')).toThrow(
      'commercial-info.md',
    );
  });
});
