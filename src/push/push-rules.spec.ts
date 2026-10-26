import { buildPushPayload, pushRecipients } from './push-rules.js';

const members = [
  { userId: 'olga', active: true },
  { userId: 'ana', active: true },
  { userId: 'ex', active: false },
];
const conversation = (
  over: Partial<{
    status: 'OPEN' | 'PENDING' | 'RESOLVED';
    assignedToId: string | null;
    paused: boolean;
  }> = {},
) => ({ status: 'OPEN' as const, assignedToId: null, paused: false, ...over });

describe('pushRecipients', () => {
  describe('an inbound message', () => {
    it('in a conversation assigned to someone: only that person', () => {
      expect(
        pushRecipients({
          reason: 'INBOUND',
          conversation: conversation({ assignedToId: 'ana' }),
          members,
        }),
      ).toEqual(['ana']);
    });

    it('assigned to someone no longer active: nobody', () => {
      expect(
        pushRecipients({
          reason: 'INBOUND',
          conversation: conversation({ assignedToId: 'ex' }),
          members,
        }),
      ).toEqual([]);
    });

    it('unassigned and PENDING: every active person of the business', () => {
      expect(
        pushRecipients({
          reason: 'INBOUND',
          conversation: conversation({ status: 'PENDING', paused: true }),
          members,
        }),
      ).toEqual(['olga', 'ana']);
    });

    it('unassigned with the bot paused (released): every active person', () => {
      expect(
        pushRecipients({
          reason: 'INBOUND',
          conversation: conversation({ paused: true }),
          members,
        }),
      ).toEqual(['olga', 'ana']);
    });

    it('attended by the bot (unassigned, not paused, OPEN): nobody', () => {
      expect(
        pushRecipients({
          reason: 'INBOUND',
          conversation: conversation(),
          members,
        }),
      ).toEqual([]);
    });
  });

  it('a handoff: every active person, never inactive ones', () => {
    expect(
      pushRecipients({
        reason: 'HANDOFF',
        conversation: conversation({ status: 'PENDING', paused: true }),
        members,
      }),
    ).toEqual(['olga', 'ana']);
  });
});

describe('buildPushPayload', () => {
  const base = {
    businessId: 'b1',
    conversationId: 'c1',
    contact: { name: null, profileName: 'Juan Pérez', waId: '5491100000001' },
  };

  it('builds the Angular service worker notification for an inbound message', () => {
    expect(
      buildPushPayload({
        ...base,
        reason: 'INBOUND',
        message: {
          type: 'TEXT',
          content: 'Perfecto, ¿me pasás el link de pago?',
        },
      }),
    ).toEqual({
      notification: {
        title: 'Juan Pérez',
        body: 'Perfecto, ¿me pasás el link de pago?',
        icon: '/icons/icon-192.png',
        badge: '/icons/maskable-192.png',
        tag: 'c1',
        renotify: true,
        data: {
          onActionClick: {
            default: {
              operation: 'navigateLastFocusedOrOpen',
              url: '/b/b1/inbox/c1',
            },
          },
        },
      },
    });
  });

  it('a handoff title says the contact wants a person', () => {
    const payload = buildPushPayload({
      ...base,
      reason: 'HANDOFF',
      message: { type: 'TEXT', content: 'quiero hablar con alguien' },
    });

    expect(payload.notification.title).toBe(
      'Juan Pérez quiere hablar con una persona',
    );
    expect(payload.notification.body).toBe('quiero hablar con alguien');
  });

  it('the name set by an operator wins; without names it is +waId', () => {
    const named = buildPushPayload({
      ...base,
      contact: { ...base.contact, name: 'Juan (Kubbo)' },
      reason: 'INBOUND',
      message: { type: 'TEXT', content: 'hola' },
    });
    const anonymous = buildPushPayload({
      ...base,
      contact: { name: null, profileName: null, waId: '5491100000001' },
      reason: 'HANDOFF',
      message: null,
    });

    expect(named.notification.title).toBe('Juan (Kubbo)');
    expect(anonymous.notification.title).toBe(
      '+5491100000001 quiere hablar con una persona',
    );
    expect(anonymous.notification.body).toBe('');
  });

  it('cuts the text to 100 characters', () => {
    const body = buildPushPayload({
      ...base,
      reason: 'INBOUND',
      message: { type: 'TEXT', content: 'a'.repeat(150) },
    }).notification.body;

    expect(body).toHaveLength(100);
    expect(body).toBe(`${'a'.repeat(99)}…`);
  });

  it('never cuts an emoji in half', () => {
    const body = buildPushPayload({
      ...base,
      reason: 'INBOUND',
      message: { type: 'TEXT', content: `${'a'.repeat(98)}😀😀😀` },
    }).notification.body;

    expect(body).toBe(`${'a'.repeat(98)}😀…`);
  });

  it.each([
    ['[audio]', 'Audio'],
    ['[image]', 'Imagen'],
    ['[video]', 'Video'],
    ['[document]', 'Documento'],
    ['[sticker]', 'Sticker'],
    ['[location]', 'Ubicación'],
    ['[contacts]', 'Contacto'],
    ['[unknown]', 'Mensaje'],
  ])('shows %s as "%s"', (content, label) => {
    expect(
      buildPushPayload({
        ...base,
        reason: 'INBOUND',
        message: { type: 'UNSUPPORTED', content },
      }).notification.body,
    ).toBe(label);
  });
});
