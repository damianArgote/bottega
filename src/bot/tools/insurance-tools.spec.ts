import { loadContent } from '../../content/content.schema.js';
import { DEFAULT_CONTENT_DIR } from '../../content/content.service.js';
import { DEFAULT_LEAD_FIELDS } from '../../agents/default-agent-profile.seed.js';
import { runAgentTurn } from '../agent-turn.js';
import { insuranceRequestSummary } from '../ai-replies.js';
import { planToolCall } from './registry.js';
import type { PlannedEffect, ToolContext } from './tool.js';

const { insurance } = loadContent(DEFAULT_CONTENT_DIR);

const ctx = (planned: PlannedEffect[] = []): ToolContext => ({
  mode: 'DEMO',
  demo: insurance,
  planned,
  demoEnabled: true,
  leadFields: DEFAULT_LEAD_FIELDS,
});

const call = (name: string, args: unknown) => ({
  callId: 'call_1',
  name,
  arguments: JSON.stringify(args),
});

const car = { model: 'Gol Trend', year: 2018, zone: 'CABA', gnc: false };

const close = (overrides: Record<string, unknown> = {}) => ({
  customerName: 'Ana',
  ...car,
  version: 'trendline',
  location: 'Caballito',
  priority: 'pagar menos',
  plan: 'terceros completo',
  contactPreference: 'por WhatsApp, a la tarde',
  ...overrides,
});

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
});

afterAll(() => {
  vi.useRealTimers();
});

describe('quote_insurance', () => {
  it('returns the simulated prices with the disclaimer', () => {
    const result = planToolCall(call('quote_insurance', car), ctx());

    expect(result.ok).toBe(true);
    const output = JSON.parse(result.output) as Record<string, unknown>;
    expect(output).toMatchObject({
      ok: true,
      disclaimer: 'Cotización simulada para demostración',
      options: [
        { plan: 'Responsabilidad Civil', monthlyArs: 20700 },
        { plan: 'Terceros Completo', monthlyArs: 36800 },
        { plan: 'Todo Riesgo', monthlyArs: 66700, deductibleArs: 400000 },
      ],
    });
    expect(result.ok && result.effect.kind).toBe('insurance_quote');
  });

  it('asks for what is missing instead of quoting', () => {
    const result = planToolCall(
      call('quote_insurance', { ...car, year: null, gnc: null }),
      ctx(),
    );

    expect(result).toMatchObject({ ok: false, reason: 'plan_rejected' });
    expect(result.output).toContain(
      'Faltan datos para cotizar: año, si tiene GNC',
    );
  });

  it('rejects a car outside the table, pointing to an advisor', () => {
    const result = planToolCall(
      call('quote_insurance', { ...car, model: 'Fiat 600' }),
      ctx(),
    );

    expect(result).toMatchObject({ ok: false, reason: 'plan_rejected' });
    expect(result.output).toContain('asesor');
  });
});

describe('register_demo_request (insurance)', () => {
  it('stores the chosen plan with the table price and hands off', () => {
    const result = planToolCall(call('register_demo_request', close()), ctx());

    expect(result).toMatchObject({
      ok: true,
      effect: {
        kind: 'register_demo_request',
        scenario: 'insurance',
        request: {
          customerName: 'Ana',
          service: 'Terceros Completo',
          details: {
            vehicle: 'Volkswagen Gol Trend Trendline',
            year: 2018,
            location: 'Caballito',
            zone: 'CABA',
            gnc: false,
            monthlyArs: 36800,
            priority: 'pagar menos',
            contactPreference: 'por WhatsApp, a la tarde',
          },
        },
        handoffReason:
          'demo seguro: Terceros Completo, Volkswagen Gol Trend Trendline 2018',
      },
    });
  });

  it.each([
    ['no name', { customerName: null }, 'Faltan datos: nombre'],
    ['an unknown version', { version: 'GTI' }, 'Versiones: Trendline'],
    ['an unknown plan', { plan: 'Platino' }, 'no es un plan disponible'],
    [
      'a plan the car is too old for',
      { year: 2014, plan: 'Todo Riesgo' },
      'no es un plan disponible',
    ],
  ])('rejects %s', (_label, overrides, message) => {
    const result = planToolCall(
      call('register_demo_request', close(overrides)),
      ctx(),
    );

    expect(result).toMatchObject({ ok: false, reason: 'plan_rejected' });
    expect(result.output).toContain(message);
  });

  it('ends the turn as a handoff, with the summary for the advisor', async () => {
    const respond = vi.fn().mockResolvedValueOnce({
      outputText: '',
      toolCalls: [call('register_demo_request', close())],
    });

    const outcome = await runAgentTurn(
      {
        request: {
          model: 'm',
          instructions: 'i',
          tools: [],
          maxOutputTokens: 1,
        },
        input: [],
        tools: {
          mode: 'DEMO',
          demo: insurance,
          demoEnabled: true,
          leadFields: [],
        },
      },
      respond,
    );

    expect(outcome.kind).toBe('handoff');
    expect(respond).toHaveBeenCalledTimes(1);
  });
});

describe('insuranceRequestSummary', () => {
  it('lists what the advisor needs, with the disclaimer', () => {
    const text = insuranceRequestSummary(
      {
        customerName: 'Ana',
        service: 'Todo Riesgo',
        details: {
          vehicle: 'Volkswagen Gol Trend Trendline',
          year: 2018,
          location: 'Caballito',
          zone: 'CABA',
          gnc: true,
          monthlyArs: 72000,
          deductibleArs: 400000,
          priority: 'mejor cobertura',
        },
      },
      'VAL-RAM Seguros',
    );

    expect(text).toBe(
      [
        '📝 Consulta lista para un asesor de VAL-RAM Seguros:',
        '• Nombre: Ana',
        '• Auto: Volkswagen Gol Trend Trendline 2018, con GNC',
        '• Localidad: Caballito (CABA)',
        '• Busca: mejor cobertura',
        '• Plan elegido: Todo Riesgo – $ 72.000 por mes',
        '• Franquicia: $ 400.000',
        '⚠️ Cotización simulada para demostración: no es una póliza ni un precio real.',
      ].join('\n'),
    );
  });
});
