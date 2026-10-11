import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ContentValidationError,
  loadContent,
  parseContent,
} from './content.schema.js';
import { DEFAULT_CONTENT_DIR } from './content.service.js';

const barbershop = () =>
  JSON.parse(
    readFileSync(join(DEFAULT_CONTENT_DIR, 'demos', 'barbershop.json'), 'utf8'),
  ) as Record<string, unknown>;

const parse = (shop: unknown, commercialInfo = '# Bottega\n\nInfo') =>
  parseContent({ commercialInfo, barbershop: JSON.stringify(shop) });

describe('content files', () => {
  it('loads the shipped content files', () => {
    const content = loadContent(DEFAULT_CONTENT_DIR);

    expect(content.barbershop.fictitious).toBe(true);
    expect(content.barbershop.services.length).toBeGreaterThan(0);
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
      (s: Record<string, unknown>) =>
        (s.services = [{ name: 'Corte', priceArs: -1, durationMinutes: 30 }]),
      'services.0.priceArs',
    ],
    [
      'an unknown booking field',
      (s: Record<string, unknown>) => (s.bookingFields = ['dni']),
      'bookingFields.0',
    ],
    ['an unknown key', (s: Record<string, unknown>) => (s.extra = 1), '(root)'],
  ])('rejects the barbershop file with %s', (_label, mutate, path) => {
    const shop = barbershop();
    mutate(shop);

    expect(() => parse(shop)).toThrow(ContentValidationError);
    expect(() => parse(shop)).toThrow(`${path}:`);
    expect(() => parse(shop)).toThrow('demos/barbershop.json');
  });

  it('rejects invalid JSON', () => {
    expect(() =>
      parseContent({ commercialInfo: 'x', barbershop: '{ nope' }),
    ).toThrow('is not valid JSON');
  });

  it('rejects a commercial info file with only comments', () => {
    expect(() => parse(barbershop(), '<!-- notes -->\n  \n')).toThrow(
      'commercial-info.md',
    );
  });

  it('reports a missing directory naming the file', () => {
    expect(() => loadContent('/nonexistent-content-dir')).toThrow(
      'commercial-info.md',
    );
  });
});
