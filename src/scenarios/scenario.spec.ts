import { readFileSync } from 'node:fs';
import {
  checkTurn,
  loadScenarioFile,
  parseScenarioFile,
  SCENARIOS_DIR,
} from './scenario.js';
import { join } from 'node:path';

const result = (
  reply: string,
  toolCalls: { name: string; accepted: boolean }[] = [],
) => ({
  reply,
  toolCalls: toolCalls.map((c) => ({ ...c, arguments: {} })),
});

describe('scenario files', () => {
  it('rejects unknown keys, empty turns and unknown tools', () => {
    const base = {
      business: 'botsuite46',
      scenarios: [{ name: 'saludo', turns: [{ user: 'hola' }] }],
    };
    expect(() => parseScenarioFile(base)).not.toThrow();
    expect(() => parseScenarioFile({ ...base, extra: 1 })).toThrow();
    expect(() =>
      parseScenarioFile({
        ...base,
        scenarios: [{ name: 'x', turns: [] }],
      }),
    ).toThrow();
    expect(() =>
      parseScenarioFile({
        ...base,
        scenarios: [
          { name: 'x', turns: [{ user: 'hola', mustCallTool: ['run_sql'] }] },
        ],
      }),
    ).toThrow();
  });

  it('BotSuite46 has the scenarios the prompt asks for, plus the ones of later fixes', () => {
    const file = loadScenarioFile(join(SCENARIOS_DIR, 'botsuite46.json'));

    expect(file.business).toBe('botsuite46');
    expect(file.scenarios.map((s) => s.name)).toEqual([
      'saludo',
      'precio-sin-dato',
      'da-su-nombre',
      'pide-humano',
      'cambiar-reglas',
      'fuera-de-tema',
      'no-repite-datos',
      'opina-demo',
      'planes-en-botones',
      'invita-demo',
      'no-demo-de-entrada',
      'demo-si-duda',
      'cierra-con-plan',
    ]);
    const tools = (name: string) =>
      file.scenarios.find((s) => s.name === name)?.turns.at(-1);
    expect(tools('da-su-nombre')?.mustCallTool).toContain('save_lead');
    expect(tools('pide-humano')?.mustCallTool).toContain('request_handoff');
    expect(tools('cierra-con-plan')?.mustCallTool).toContain('request_handoff');
    // The raw file is valid JSON with no comments.
    expect(() => {
      JSON.parse(readFileSync(join(SCENARIOS_DIR, 'botsuite46.json'), 'utf8'));
    }).not.toThrow();
  });
});

describe('checkTurn', () => {
  it('passes when every assertion holds', () => {
    expect(
      checkTurn(
        {
          user: 'hola',
          mustInclude: ['botsuite', ['equipo', 'persona']],
          mustNotInclude: ['asistente virtual'],
          mustCallTool: ['save_lead'],
          mustNotCallTool: ['request_handoff'],
        },
        result('¡Hola! Soy BotSuite. El equipo te ayuda.', [
          { name: 'save_lead', accepted: true },
        ]),
      ),
    ).toEqual([]);
  });

  it('mustNotOffer fails when offer_options includes one of those options', () => {
    const offered = (options: string[]) => ({
      reply: 'x',
      toolCalls: [
        { name: 'offer_options', accepted: true, arguments: { options } },
      ],
    });

    expect(
      checkTurn(
        { user: 'Pro', mustNotOffer: ['Pro'] },
        offered(['Inicial', 'Ventas']),
      ),
    ).toEqual([]);
    expect(
      checkTurn(
        { user: 'Pro', mustNotOffer: ['pro'] },
        offered(['Inicial', 'Plan Pro']),
      ),
    ).toEqual(['mustNotOffer "pro"']);
  });

  it('mustOffer fails unless an accepted offer_options includes each text', () => {
    const offered = (options: string[], accepted = true) => ({
      reply: 'x',
      toolCalls: [{ name: 'offer_options', accepted, arguments: { options } }],
    });

    expect(
      checkTurn(
        { user: 'no sé', mustOffer: ['probar la demo'] },
        offered(['🧪 Probar la demo']),
      ),
    ).toEqual([]);
    expect(
      checkTurn(
        { user: 'no sé', mustOffer: ['Probar la demo'] },
        offered(['Ver planes']),
      ),
    ).toEqual(['mustOffer "Probar la demo"']);
    expect(
      checkTurn(
        { user: 'no sé', mustOffer: ['Probar la demo'] },
        offered(['🧪 Probar la demo'], false),
      ),
    ).toEqual(['mustOffer "Probar la demo"']);
  });

  it('matches text ignoring case and accents', () => {
    expect(
      checkTurn(
        { user: 'x', mustInclude: ['informacion'], mustNotInclude: ['MESSI'] },
        result('Te paso la INFORMACIÓN.'),
      ),
    ).toEqual([]);
  });

  it('reports each failed assertion', () => {
    expect(
      checkTurn(
        {
          user: 'x',
          mustInclude: ['plazo', ['equipo', 'persona']],
          mustNotInclude: ['asistente virtual'],
          mustCallTool: ['save_lead'],
          mustNotCallTool: ['request_handoff'],
        },
        result('Soy tu asistente virtual.', [
          { name: 'save_lead', accepted: false },
          { name: 'request_handoff', accepted: false },
        ]),
      ),
    ).toEqual([
      'mustInclude "plazo"',
      'mustInclude one of "equipo" | "persona"',
      'mustNotInclude "asistente virtual"',
      'mustCallTool save_lead (no accepted call)',
      'mustNotCallTool request_handoff',
    ]);
  });
});
