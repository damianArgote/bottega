import { parseWebhookPayload } from './payload.parser.js';

const PHONE_NUMBER_ID = '111111111111111';
const BUSINESS_DISPLAY = '15550001111';

function payload(
  value: Record<string, unknown>,
  overrides: { field?: string; object?: string } = {},
) {
  return {
    object: overrides.object ?? 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: overrides.field ?? 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: BUSINESS_DISPLAY,
                phone_number_id: PHONE_NUMBER_ID,
              },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

const parse = (raw: unknown) =>
  parseWebhookPayload(raw, { phoneNumberId: PHONE_NUMBER_ID });

describe('parseWebhookPayload', () => {
  it('normalizes a mixed batch and skips malformed items', () => {
    const events = parse(
      payload({
        contacts: [{ wa_id: '5491100001234', profile: { name: 'Ana' } }],
        messages: [
          {
            from: '5491100001234',
            id: 'wamid.text',
            timestamp: '1760140800',
            type: 'text',
            text: { body: 'hola' },
          },
          {
            from: '5491100005678',
            id: 'wamid.image',
            timestamp: '1760140801',
            type: 'image',
            image: { id: 'media-1' },
          },
          { from: '5491100001234', type: 'text' }, // missing id/timestamp
          'not-an-object',
          {
            from: '5491100001234',
            id: 'wamid.reaction',
            timestamp: '1760140802',
            type: 'reaction',
          },
        ],
        statuses: [
          {
            id: 'wamid.out',
            status: 'failed',
            timestamp: '1760140803',
            recipient_id: '5491100001234',
            errors: [{ code: 131047, title: 'Re-engagement message' }],
          },
          { id: 'wamid.bad-status' },
        ],
      }),
    );

    expect(events).toEqual([
      {
        kind: 'text',
        waMessageId: 'wamid.text',
        from: '5491100001234',
        timestamp: new Date(1760140800 * 1000),
        text: 'hola',
        profileName: 'Ana',
      },
      {
        kind: 'unsupported',
        waMessageId: 'wamid.image',
        from: '5491100005678',
        timestamp: new Date(1760140801 * 1000),
        messageType: 'image',
      },
      { kind: 'ignored', reason: 'malformed message' },
      { kind: 'ignored', reason: 'malformed message' },
      { kind: 'ignored', reason: 'ignored message type' },
      {
        kind: 'status',
        waMessageId: 'wamid.out',
        status: 'failed',
        recipientId: '5491100001234',
        timestamp: new Date(1760140803 * 1000),
        errors: [{ code: 131047, title: 'Re-engagement message' }],
      },
      { kind: 'ignored', reason: 'malformed status' },
    ]);
  });

  it('handles several entries and changes in one delivery', () => {
    const single = payload({
      messages: [
        {
          from: '5491100001234',
          id: 'wamid.a',
          timestamp: '1',
          type: 'text',
          text: { body: 'a' },
        },
      ],
    });
    const raw = {
      ...single,
      entry: [single.entry[0], single.entry[0], { changes: 'nope' }],
    };

    const kinds = parse(raw).map((event) => event.kind);

    expect(kinds).toEqual(['text', 'text', 'ignored']);
  });

  it.each([
    ['null', null],
    ['a string', 'payload'],
    ['an object without entry', { object: 'whatsapp_business_account' }],
  ])('ignores %s without throwing', (_label, raw) => {
    expect(parse(raw)).toEqual([
      { kind: 'ignored', reason: 'malformed payload' },
    ]);
  });

  it('ignores other object types', () => {
    expect(parse(payload({}, { object: 'page' }))).toEqual([
      { kind: 'ignored', reason: 'unexpected object type' },
    ]);
  });

  it('ignores changes for fields other than messages', () => {
    expect(parse(payload({}, { field: 'account_update' }))).toEqual([
      { kind: 'ignored', reason: 'unsupported change field' },
    ]);
  });

  it('ignores events addressed to another phone number id', () => {
    const events = parseWebhookPayload(
      payload({
        messages: [
          {
            from: '5491100001234',
            id: 'wamid.x',
            timestamp: '1',
            type: 'text',
            text: { body: 'x' },
          },
        ],
      }),
      { phoneNumberId: '999' },
    );

    expect(events).toEqual([
      { kind: 'ignored', reason: 'event for another phone number id' },
    ]);
  });

  it('ignores messages sent from the business number itself', () => {
    const events = parse(
      payload({
        messages: [
          {
            from: BUSINESS_DISPLAY,
            id: 'wamid.self',
            timestamp: '1',
            type: 'text',
            text: { body: 'loop' },
          },
        ],
      }),
    );

    expect(events).toEqual([
      { kind: 'ignored', reason: 'message from the business number' },
    ]);
  });

  it('ignores a text message without body and omits unknown profile names', () => {
    const events = parse(
      payload({
        messages: [
          { from: '1', id: 'wamid.1', timestamp: '1', type: 'text' },
          {
            from: '2',
            id: 'wamid.2',
            timestamp: '1',
            type: 'text',
            text: { body: 'hi' },
          },
        ],
      }),
    );

    expect(events[0]).toEqual({
      kind: 'ignored',
      reason: 'text message without body',
    });
    expect(events[1]).not.toHaveProperty('profileName');
  });
});
