import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import {
  BlockedAddressError,
  createSafeFetch,
  isPublicAddress,
  ResponseTooLargeError,
} from './safe-fetch.js';

describe('isPublicAddress', () => {
  it.each([
    '10.0.0.1',
    '172.16.5.4',
    '192.168.1.1',
    '127.0.0.1',
    '0.0.0.0',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00:ec2::254',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
    'not-an-ip',
  ])('rejects %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8'])(
    'accepts %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

/** A fake https.request that answers `status` with `body`. */
function fakeRequest(status: number, body = '') {
  const seen: RequestOptions[] = [];
  const request = (options: RequestOptions) => {
    seen.push(options);
    const req = new EventEmitter() as ClientRequest;
    req.end = ((sent?: string) => {
      setImmediate(() => {
        const res = new EventEmitter() as IncomingMessage;
        res.statusCode = status;
        res.headers = { 'content-type': 'application/json' };
        res.destroy = (() => res);
        req.emit('response', res);
        if (body) {
          res.emit('data', Buffer.from(body));
        }
        res.emit('end');
      });
      void sent;
      return req;
    }) as ClientRequest['end'];
    return req;
  };
  return { request, seen };
}

describe('createSafeFetch', () => {
  const post = (fetchImpl: typeof fetch, url: string) =>
    fetchImpl(url, { method: 'POST', body: '{}' });

  it('rejects an IP literal or a host that resolves to a private address, before connecting', async () => {
    const { request, seen } = fakeRequest(200);
    const resolve = vi.fn((host: string) =>
      Promise.resolve(
        host === 'mixed.example'
          ? [
              { address: '93.184.216.34', family: 4 },
              { address: '10.0.0.5', family: 4 },
            ]
          : [{ address: '127.0.0.1', family: 4 }],
      ),
    );
    const safe = createSafeFetch({ maxResponseBytes: 100 }, { resolve, request });

    for (const url of [
      'https://127.0.0.1/hook',
      'https://[::1]/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/hook',
      'https://mixed.example/hook',
    ]) {
      await expect(post(safe, url)).rejects.toBeInstanceOf(BlockedAddressError);
    }
    expect(seen).toHaveLength(0);
  });

  it('only accepts https without credentials', async () => {
    const { request } = fakeRequest(200);
    const safe = createSafeFetch({ maxResponseBytes: 100 }, { request });

    await expect(post(safe, 'http://example.com/')).rejects.toThrow(TypeError);
    await expect(post(safe, 'https://u:p@example.com/')).rejects.toThrow(
      TypeError,
    );
  });

  it('connects to the address it checked, with the host for TLS, and returns redirects as they are', async () => {
    const { request, seen } = fakeRequest(302);
    const resolve = () =>
      Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
    const safe = createSafeFetch({ maxResponseBytes: 100 }, { resolve, request });

    const response = await post(safe, 'https://n8n.example.com:8443/a?b=1');

    expect(response.status).toBe(302);
    const options = seen[0]!;
    expect(options).toMatchObject({
      hostname: 'n8n.example.com',
      servername: 'n8n.example.com',
      port: '8443',
      path: '/a?b=1',
      method: 'POST',
    });
    // Whatever the socket asks the lookup, it gets the checked address.
    const lookup = options.lookup as LookupFunction;
    const single = await new Promise((done) =>
      lookup('n8n.example.com', {}, (_e, address) => done(address)),
    );
    const all = await new Promise((done) =>
      lookup('n8n.example.com', { all: true }, (_e, addresses) =>
        done(addresses),
      ),
    );
    expect(single).toBe('93.184.216.34');
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('returns the body under the cap and fails over it', async () => {
    const resolve = () =>
      Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
    const small = createSafeFetch(
      { maxResponseBytes: 10 },
      { resolve, request: fakeRequest(200, '{"a":1}').request },
    );
    const big = createSafeFetch(
      { maxResponseBytes: 10 },
      { resolve, request: fakeRequest(200, '{"a":"0123456789"}').request },
    );

    expect(await (await post(small, 'https://x.example/')).json()).toEqual({
      a: 1,
    });
    await expect(post(big, 'https://x.example/')).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });
});
