import type {
  WhatsAppClient,
  WhatsAppClientFactory,
} from '../../src/whatsapp/whatsapp.client.js';

/**
 * A client factory that hands out the same test client for every line, and
 * records which line was asked for (`forLine.mock.calls`).
 */
export function fixedClientFactory(client: WhatsAppClient) {
  const forLine = vi.fn<WhatsAppClientFactory['forLine']>(() =>
    Promise.resolve(client),
  );
  return { forLine } satisfies WhatsAppClientFactory;
}
