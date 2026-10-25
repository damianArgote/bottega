import { loadContent } from '../../content/content.schema.js';
import { DEFAULT_CONTENT_DIR } from '../../content/content.service.js';
import { MODE_PROFILES, type ToolName } from '../mode-profiles.js';
import {
  planToolCall,
  TOOL_HANDLERS,
  toolDefinitionsFor,
  type ToolCallResult,
} from './registry.js';
import type { PlannedEffect, ToolContext } from './tool.js';

const barbershop = loadContent(DEFAULT_CONTENT_DIR).barbershop;

const ctx = (
  mode: ToolContext['mode'],
  planned: PlannedEffect[] = [],
  demoEnabled = true,
): ToolContext => ({ mode, barbershop, planned, demoEnabled });

const call = (name: string, args: unknown) => ({
  callId: 'call_1',
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
});

const lead = (overrides: Record<string, unknown> = {}) => ({
  name: null,
  businessName: null,
  industry: null,
  need: null,
  contactNotes: null,
  ...overrides,
});

const booking = (overrides: Record<string, unknown> = {}) => ({
  customerName: 'Juan',
  service: 'corte de pelo',
  preferredDate: 'sábado',
  preferredTime: '11:00',
  notes: null,
  ...overrides,
});

function expectRejected(result: ToolCallResult, reason: string) {
  expect(result).toMatchObject({ ok: false, reason });
  const output = JSON.parse(result.output) as { ok: boolean; error: string };
  expect(output.ok).toBe(false);
  expect(output.error).toContain('NO se realizó');
}

describe('tool registry', () => {
  it('keeps every JSON schema strict and mirrored by its zod schema', () => {
    for (const tool of Object.values(TOOL_HANDLERS)) {
      const schema = tool.jsonSchema as {
        properties: Record<string, { type: string[] }>;
        required: string[];
        additionalProperties: boolean;
      };
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual(Object.keys(schema.properties));
      for (const prop of Object.values(schema.properties)) {
        expect(prop.type).toEqual(['string', 'null']);
      }
      // All-null arguments parse (every key accepted), extra keys do not.
      const nulls = Object.fromEntries(schema.required.map((k) => [k, null]));
      expect(tool.schema.safeParse(nulls).success).toBe(true);
      expect(tool.schema.safeParse({ ...nulls, extra: 'x' }).success).toBe(
        false,
      );
    }
  });

  it('offers each mode exactly its allowed tools, consistent with allowedModes', () => {
    for (const profile of Object.values(MODE_PROFILES)) {
      const names = toolDefinitionsFor(profile.mode, { demoEnabled: true }).map(
        (t) => t.name,
      );
      expect(names).toEqual(profile.allowedTools);
      for (const name of names) {
        expect(TOOL_HANDLERS[name as ToolName].allowedModes).toContain(
          profile.mode,
        );
      }
    }
  });

  it('rejects unknown tools, invalid JSON and tools outside the mode', () => {
    expectRejected(
      planToolCall(call('run_sql', {}), ctx('COMMERCIAL')),
      'unknown_tool',
    );
    expectRejected(
      planToolCall(call('toString', {}), ctx('COMMERCIAL')),
      'unknown_tool',
    );
    expectRejected(
      planToolCall(call('save_lead', '{not json'), ctx('COMMERCIAL')),
      'invalid_json',
    );
    expectRejected(
      planToolCall(call('save_lead', lead({ name: 'Ana' })), ctx('DEMO')),
      'tool_not_allowed',
    );
    expectRejected(
      planToolCall(call('register_demo_request', booking()), ctx('COMMERCIAL')),
      'tool_not_allowed',
    );
  });

  describe('save_lead', () => {
    it('plans only the non-empty fields, cleaned', () => {
      const result = planToolCall(
        call(
          'save_lead',
          lead({ name: '  Ana\n\u0007 Pérez ', industry: '', need: 'turnos' }),
        ),
        ctx('COMMERCIAL'),
      );
      expect(result).toMatchObject({
        ok: true,
        effect: {
          kind: 'save_lead',
          fields: { name: 'Ana Pérez', need: 'turnos' },
        },
      });
    });

    it('rejects extra fields, missing fields, long values, links and empty calls', () => {
      const commercial = ctx('COMMERCIAL');
      expectRejected(
        planToolCall(call('save_lead', lead({ email: 'a@b.c' })), commercial),
        'invalid_arguments',
      );
      expectRejected(
        planToolCall(call('save_lead', { name: 'Ana' }), commercial),
        'invalid_arguments',
      );
      expectRejected(
        planToolCall(
          call('save_lead', lead({ need: 'x'.repeat(201) })),
          commercial,
        ),
        'invalid_arguments',
      );
      expectRejected(
        planToolCall(
          call('save_lead', lead({ contactNotes: 'ver https://evil.test' })),
          commercial,
        ),
        'invalid_arguments',
      );
      expectRejected(
        planToolCall(call('save_lead', lead({ name: ' \n ' })), commercial),
        'plan_rejected',
      );
    });
  });

  describe('register_demo_request', () => {
    it('plans a request with the canonical service name', () => {
      const result = planToolCall(
        call('register_demo_request', booking({ service: 'CORTE + BARBA' })),
        ctx('DEMO'),
      );
      expect(result).toMatchObject({
        ok: true,
        effect: {
          kind: 'register_demo_request',
          request: {
            customerName: 'Juan',
            service: 'Corte + barba',
            preferredDate: 'sábado',
            preferredTime: '11:00',
          },
        },
      });
      expect(JSON.parse(result.output)).toMatchObject({
        ok: true,
        fictitious: true,
      });
    });

    it('rejects unknown services, missing booking fields and duplicates', () => {
      expectRejected(
        planToolCall(
          call('register_demo_request', booking({ service: 'Tintura' })),
          ctx('DEMO'),
        ),
        'plan_rejected',
      );
      expectRejected(
        planToolCall(
          call('register_demo_request', booking({ preferredTime: null })),
          ctx('DEMO'),
        ),
        'plan_rejected',
      );
      expectRejected(
        planToolCall(
          call('register_demo_request', booking()),
          ctx('DEMO', [{ kind: 'register_demo_request', request: {} }]),
        ),
        'plan_rejected',
      );
    });
  });

  describe('request_handoff', () => {
    it('is allowed in both modes and keeps a cleaned reason', () => {
      for (const mode of ['COMMERCIAL', 'DEMO'] as const) {
        expect(
          planToolCall(
            call('request_handoff', { reason: 'quiere\tprecios' }),
            ctx(mode),
          ),
        ).toMatchObject({
          ok: true,
          effect: { kind: 'request_handoff', reason: 'quiere precios' },
        });
      }
      expectRejected(
        planToolCall(
          call('request_handoff', { reason: null, now: true }),
          ctx('DEMO'),
        ),
        'invalid_arguments',
      );
    });
  });

  describe('without the demo (demoEnabled false)', () => {
    it('register_demo_request is not offered', () => {
      const names = (mode: ToolContext['mode'], demoEnabled: boolean) =>
        toolDefinitionsFor(mode, { demoEnabled }).map((t) => t.name);

      expect(names('DEMO', false)).not.toContain('register_demo_request');
      expect(names('DEMO', false)).toContain('request_handoff');
      expect(names('DEMO', true)).toContain('register_demo_request');
      expect(names('COMMERCIAL', false)).toEqual([
        'save_lead',
        'request_handoff',
      ]);
    });

    it('register_demo_request is rejected if the model calls it anyway', () => {
      expectRejected(
        planToolCall(
          call('register_demo_request', booking()),
          ctx('DEMO', [], false),
        ),
        'tool_not_allowed',
      );
    });
  });
});
