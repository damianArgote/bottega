import {
  META_DOCUMENT,
  META_IMAGE,
  META_LOCATION,
  META_STICKER,
  META_VIDEO,
  META_VOICE_NOTE,
} from '../../test/fixtures/meta-media-messages.js';
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

/** Events without their phone_number_id (asserted in its own tests). */
const parse = (raw: unknown) =>
  parseWebhookPayload(raw).map((event) => {
    if (event.kind === 'ignored') {
      return event;
    }
    const rest: Partial<typeof event> = { ...event };
    delete rest.phoneNumberId;
    return rest;
  });

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
        media: { kind: 'image', mediaId: 'media-1' },
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

  it('returns the phone_number_id of each change on its events', () => {
    const raw = payload({
      messages: [
        {
          from: '5491100001234',
          id: 'wamid.x',
          timestamp: '1',
          type: 'text',
          text: { body: 'x' },
        },
      ],
      statuses: [
        {
          id: 'wamid.out',
          status: 'read',
          timestamp: '2',
          recipient_id: '5491100001234',
        },
      ],
    });

    expect(
      parseWebhookPayload(raw).map((event) =>
        event.kind === 'ignored' ? event.kind : event.phoneNumberId,
      ),
    ).toEqual([PHONE_NUMBER_ID, PHONE_NUMBER_ID]);
  });

  it('does not filter by phone number id: each change keeps its own', () => {
    const raw = payload({
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
    const second = structuredClone(raw.entry[0]!.changes[0]!) as {
      field: string;
      value: { metadata: { phone_number_id: string }; messages?: unknown[] };
    };
    second.value.metadata.phone_number_id = '999';
    second.value.messages = [
      {
        from: '5491100001234',
        id: 'wamid.b',
        timestamp: '1',
        type: 'text',
        text: { body: 'b' },
      },
    ];
    (raw.entry[0]!.changes as unknown[]).push(second);

    expect(
      parseWebhookPayload(raw).map((event) =>
        event.kind === 'text' ? [event.waMessageId, event.phoneNumberId] : null,
      ),
    ).toEqual([
      ['wamid.a', PHONE_NUMBER_ID],
      ['wamid.b', '999'],
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

  it('reads a tapped reply button or list option as the text of its title', () => {
    const events = parse(
      payload({
        messages: [
          {
            from: '1',
            id: 'wamid.b',
            timestamp: '1',
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: { id: 'demo', title: 'Probar la demo' },
            },
          },
          {
            from: '1',
            id: 'wamid.l',
            timestamp: '1',
            type: 'interactive',
            interactive: {
              type: 'list_reply',
              list_reply: { id: 'pro', title: 'Plan Pro', description: 'x' },
            },
          },
          {
            from: '1',
            id: 'wamid.x',
            timestamp: '1',
            type: 'interactive',
            interactive: { type: 'nfm_reply' },
          },
        ],
      }),
    );

    expect(events[0]).toMatchObject({ kind: 'text', text: 'Probar la demo' });
    expect(events[1]).toMatchObject({ kind: 'text', text: 'Plan Pro' });
    expect(events[2]).toMatchObject({
      kind: 'unsupported',
      messageType: 'interactive',
    });
  });
});

describe('parseWebhookPayload attachments', () => {
  const one = (message: unknown) =>
    parse(
      payload({
        contacts: [{ wa_id: '5491100001234', profile: { name: 'Ana' } }],
        messages: [message],
      }),
    )[0];
  const at = new Date(1760140800 * 1000);
  const sender = { from: '5491100001234', timestamp: at, profileName: 'Ana' };

  it('keeps a voice note with its media id, type and the contact name', () => {
    expect(one(META_VOICE_NOTE)).toEqual({
      kind: 'unsupported',
      waMessageId: 'wamid.voice',
      ...sender,
      messageType: 'audio',
      media: {
        kind: 'audio',
        mediaId: '1234567890001',
        mime: 'audio/ogg; codecs=opus',
        voice: true,
      },
    });
  });

  it('keeps the caption of an image and the file name of a document', () => {
    expect(one(META_IMAGE)).toMatchObject({
      messageType: 'image',
      media: {
        kind: 'image',
        mediaId: '1234567890002',
        mime: 'image/jpeg',
        caption: '¿Tienen esta torta?',
      },
    });
    expect(one(META_DOCUMENT)).toMatchObject({
      media: {
        kind: 'document',
        mime: 'application/pdf',
        filename: 'pedido.pdf',
        caption: 'Mi pedido',
      },
    });
  });

  it('keeps videos and stickers as attachments', () => {
    expect(one(META_VIDEO)).toMatchObject({
      kind: 'unsupported',
      media: { kind: 'video', mediaId: '1234567890004', mime: 'video/mp4' },
    });
    expect(one(META_STICKER)).toMatchObject({
      kind: 'unsupported',
      media: { kind: 'sticker', mime: 'image/webp' },
    });
  });

  it('turns a location into text', () => {
    expect(one(META_LOCATION)).toEqual({
      kind: 'text',
      waMessageId: 'wamid.location',
      ...sender,
      text: 'Ubicación: KUBBO, Presidente Camilo Tenorio 2036 (-34.6301, -58.4637)',
      media: { kind: 'location' },
    });
    expect(
      one({
        ...META_LOCATION,
        location: { latitude: 1.5, longitude: 2 },
      }),
    ).toMatchObject({ text: 'Ubicación: (1.5, 2)' });
  });

  it('keeps a message whose media object Meta sends in another shape', () => {
    expect(
      one({ ...META_IMAGE, image: { mime_type: 'image/jpeg' } }),
    ).toMatchObject({ kind: 'unsupported', messageType: 'image' });
    expect(
      one({ ...META_IMAGE, image: { id: '1', file_size: '1234', caption: 7 } }),
    ).toMatchObject({ media: { kind: 'image', mediaId: '1', size: 1234 } });
    expect(
      one({ ...META_LOCATION, location: { latitude: 'x' } }),
    ).toMatchObject({ kind: 'unsupported', messageType: 'location' });
  });

  it('leaves unknown types without media, as before', () => {
    expect(
      one({
        from: '5491100001234',
        id: 'wamid.x',
        timestamp: '1760140800',
        type: 'unsupported',
      }),
    ).toEqual({
      kind: 'unsupported',
      waMessageId: 'wamid.x',
      ...sender,
      messageType: 'unsupported',
    });
  });
});
