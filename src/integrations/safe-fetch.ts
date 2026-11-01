import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Address ranges a business URL may never reach: private, loopback,
 * link-local (cloud metadata lives at 169.254.169.254 and fd00:ec2::254),
 * carrier-grade NAT, documentation, benchmarking, multicast and reserved.
 */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  // IPv4-compatible (::a.b.c.d, also :: and ::1) and SIIT (::ffff:0:a.b.c.d).
  ['::', 96],
  ['::ffff:0:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

const MAPPED_V4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/** True only for a public unicast address (IPv4 or IPv6). */
export function isPublicAddress(address: string): boolean {
  const mapped = MAPPED_V4.exec(address);
  if (mapped) {
    return isPublicAddress(mapped[1]!);
  }
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  return !BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** The URL's host is (or resolves to) an address it may not reach. */
export class BlockedAddressError extends Error {
  override readonly name = 'BlockedAddressError';
  constructor() {
    super('The host resolves to a non-public address');
  }
}

/** The response body went over the allowed size. */
export class ResponseTooLargeError extends Error {
  override readonly name = 'ResponseTooLargeError';
  constructor() {
    super('The response body is too large');
  }
}

type Resolve = (hostname: string) => Promise<LookupAddress[]>;

const resolveAll: Resolve = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    );
  });

export interface SafeFetchDeps {
  resolve?: Resolve;
  request?: (options: RequestOptions) => ClientRequest;
}

export interface SafeFetchOptions {
  /** The body is read up to this many bytes; more is ResponseTooLargeError. */
  maxResponseBytes: number;
  /**
   * Over the cap: `fail` (default) rejects with ResponseTooLargeError;
   * `truncate` stops reading and returns the status with what fit (maybe nothing)
   * (for callers that only need the status, like webhook deliveries).
   */
  oversize?: 'fail' | 'truncate';
}

/**
 * A `fetch` for URLs a business gave us (webhooks, business actions): HTTPS
 * only; the host is resolved first and every address must be public, and
 * the connection goes to that checked address (no second lookup a DNS
 * rebinding could change); redirects are never followed (a 3xx is returned
 * as is); the body is capped. Supports what those callers use: method,
 * string body, headers and `signal`.
 */
export function createSafeFetch(
  { maxResponseBytes, oversize = 'fail' }: SafeFetchOptions,
  deps: SafeFetchDeps = {},
): typeof fetch {
  const resolve = deps.resolve ?? resolveAll;
  const request = deps.request ?? httpsRequest;

  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new TypeError('Only https URLs without credentials');
    }
    init?.signal?.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // The lookup counts inside the caller's timeout.
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await untilAborted(resolve(host), init?.signal ?? undefined);
    if (
      addresses.length === 0 ||
      !addresses.every((a) => isPublicAddress(a.address))
    ) {
      throw new BlockedAddressError();
    }
    const checked = addresses.map((a) => ({
      address: a.address,
      family: a.family,
    }));
    // Hands the socket only the checked addresses, whatever it asks for:
    // all of them, so it tries the next one when one does not connect.
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, checked);
      } else {
        callback(null, checked[0]!.address, checked[0]!.family);
      }
    };

    const body = typeof init?.body === 'string' ? init.body : undefined;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    return new Promise<Response>((resolveResponse, reject) => {
      const options: RequestOptions & { autoSelectFamily: boolean } = {
        protocol: 'https:',
        hostname: host,
        servername: isIP(host) ? undefined : host,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? 'GET',
        headers,
        lookup,
        // Tries each address (both families) until one connects.
        autoSelectFamily: true,
        ...(init?.signal ? { signal: init.signal } : {}),
      };
      const req = request(options);
      req.on('error', reject);
      req.on('response', (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        res.on('data', (chunk: Buffer) => {
          if (done) {
            return;
          }
          size += chunk.length;
          if (size > maxResponseBytes) {
            done = true;
            res.destroy();
            if (oversize === 'truncate') {
              finish();
            } else {
              reject(new ResponseTooLargeError());
            }
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (error) => {
          if (!done) {
            reject(error);
          }
        });
        res.on('end', () => {
          if (!done) {
            done = true;
            finish();
          }
        });
        function finish() {
          const status = res.statusCode ?? 0;
          const empty = status === 204 || status === 304;
          resolveResponse(
            new Response(empty ? null : Buffer.concat(chunks), {
              // A status Response cannot hold counts as a server error.
              status: status >= 200 && status <= 599 ? status : 599,
              headers: Object.entries(res.headers).flatMap(([key, value]) =>
                value === undefined
                  ? []
                  : (Array.isArray(value) ? value : [value]).map(
                      (v) => [key, v] as [string, string],
                    ),
              ),
            }),
          );
        }
      });
      req.end(body);
    });
  };
}

/** `pending`, or the signal's reason as soon as it aborts. */
function untilAborted<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return pending;
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
