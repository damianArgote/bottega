import { loadContent } from '../content/content.schema.js';
import { DEFAULT_CONTENT_DIR } from '../content/content.service.js';
import { findVehicle, quoteInsurance } from './insurance-quote.js';

const { insurance } = loadContent(DEFAULT_CONTENT_DIR);
const YEAR = 2026;

const quote = (request: Partial<Parameters<typeof quoteInsurance>[1]>) =>
  quoteInsurance(
    insurance,
    { model: 'Gol Trend', year: 2018, zone: 'CABA', gnc: false, ...request },
    YEAR,
  );

describe('quoteInsurance', () => {
  it('prices every plan from the table: category × zone, rounded to hundreds', () => {
    expect(quote({})).toEqual({
      ok: true,
      quote: {
        vehicle: {
          make: 'Volkswagen',
          model: 'Gol Trend',
          versions: ['Trendline', 'Comfortline', 'Highline'],
        },
        zone: 'CABA',
        year: 2018,
        gnc: false,
        options: [
          {
            plan: 'Responsabilidad Civil',
            monthlyArs: 20700,
            deductibleArs: null,
          },
          { plan: 'Terceros Completo', monthlyArs: 36800, deductibleArs: null },
          { plan: 'Todo Riesgo', monthlyArs: 66700, deductibleArs: 400000 },
        ],
        notAvailable: [],
      },
    });
  });

  it('adds the GNC surcharge and uses the zone factor', () => {
    const result = quote({ gnc: true, zone: 'interior' });

    expect(result.ok && result.quote.options[0]).toEqual({
      plan: 'Responsabilidad Civil',
      // 18000 × 0.90 × 1.08 = 17496
      monthlyArs: 17500,
      deductibleArs: null,
    });
  });

  it('a different car gives different prices (category)', () => {
    const result = quote({ model: 'ford ranger' });

    expect(result.ok && result.quote.options[0]?.monthlyArs).toBe(34500);
  });

  it('leaves out plans that do not take a car that old', () => {
    const result = quote({ year: 2014 });

    expect(result.ok && result.quote.options.map((o) => o.plan)).toEqual([
      'Responsabilidad Civil',
      'Terceros Completo',
    ]);
    expect(result.ok && result.quote.notAvailable).toEqual(['Todo Riesgo']);
  });

  it.each([
    ['a car not in the table', { model: 'Fiat 600' }, 'no está en la tabla'],
    ['a year before the table', { year: 2005 }, 'entre 2010 y 2027'],
    ['a year in the future', { year: 2030 }, 'entre 2010 y 2027'],
    ['an unknown zone', { zone: 'Marte' }, 'Zona desconocida'],
  ])('rejects %s with a message for the model', (_label, request, message) => {
    const result = quote(request);

    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain(message);
  });

  it('finds vehicles by model or make + model, ignoring case and accents', () => {
    expect(findVehicle(insurance, 'GOL  trend')?.model).toBe('Gol Trend');
    expect(findVehicle(insurance, 'Peugeot 208')?.model).toBe('208');
    expect(findVehicle(insurance, 'Gol')).toBeNull();
  });
});
