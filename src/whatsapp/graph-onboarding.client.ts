import type { GraphClientOptions } from './graph-whatsapp.client.js';

/** A Graph error, or a request that never got an answer (`network_error`). */
export interface GraphFailure {
  code: number | 'network_error';
  subcode: number | null;
  httpStatus: number | null;
  message: string;
}

export type GraphResult<T> =
  { ok: true; data: T } | { ok: false; error: GraphFailure };

export interface WabaInfo {
  id: string;
  name: string | null;
}

export interface PhoneNumberInfo {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  codeVerificationStatus: string | null;
  nameStatus: string | null;
  qualityRating: string | null;
}

export interface SubscribedApp {
  id: string;
  name: string | null;
}

const MAX_ERROR_MESSAGE_LENGTH = 200;

const PHONE_FIELDS =
  'id,display_phone_number,verified_name,code_verification_status,name_status,quality_rating';

type Json = Record<string, unknown>;

const str = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

function phoneNumber(raw: Json): PhoneNumberInfo {
  return {
    id: String(raw['id']),
    displayPhoneNumber: str(raw['display_phone_number']),
    verifiedName: str(raw['verified_name']),
    codeVerificationStatus: str(raw['code_verification_status']),
    nameStatus: str(raw['name_status']),
    qualityRating: str(raw['quality_rating']),
  };
}

/**
 * The Graph calls used to onboard a line: check credentials, list and
 * register numbers, read the app subscriptions and a number's state. Never
 * throws and never logs: the token, the app secret and the PIN only travel
 * in the request to Meta.
 */
export class GraphOnboardingClient {
  private readonly baseUrl: string;

  constructor(
    private readonly options: GraphClientOptions,
    private readonly fetchImpl: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {
    this.baseUrl = `${options.baseUrl ?? 'https://graph.facebook.com'}/${options.apiVersion}`;
  }

  async waba(wabaId: string, token: string): Promise<GraphResult<WabaInfo>> {
    const result = await this.request('GET', `${wabaId}?fields=id,name`, token);
    return result.ok
      ? {
          ok: true,
          data: {
            id: String(result.data['id']),
            name: str(result.data['name']),
          },
        }
      : result;
  }

  /** Checks an app secret: Meta only answers with the right app token. */
  async app(appId: string, appSecret: string): Promise<GraphResult<true>> {
    const result = await this.request(
      'GET',
      `${appId}?fields=id`,
      `${appId}|${appSecret}`,
    );
    return result.ok ? { ok: true, data: true } : result;
  }

  async phoneNumbers(
    wabaId: string,
    token: string,
  ): Promise<GraphResult<PhoneNumberInfo[]>> {
    const result = await this.request(
      'GET',
      `${wabaId}/phone_numbers?fields=${PHONE_FIELDS}`,
      token,
    );
    if (!result.ok) {
      return result;
    }
    const data = Array.isArray(result.data['data']) ? result.data['data'] : [];
    return { ok: true, data: (data as Json[]).map(phoneNumber) };
  }

  async phoneNumber(
    phoneNumberId: string,
    token: string,
  ): Promise<GraphResult<PhoneNumberInfo>> {
    const result = await this.request(
      'GET',
      `${phoneNumberId}?fields=${PHONE_FIELDS}`,
      token,
    );
    return result.ok ? { ok: true, data: phoneNumber(result.data) } : result;
  }

  /** `POST /{phone-number-id}/register`: sets the number's two-step PIN. */
  async register(
    phoneNumberId: string,
    pin: string,
    token: string,
  ): Promise<GraphResult<true>> {
    const result = await this.request(
      'POST',
      `${phoneNumberId}/register`,
      token,
      {
        messaging_product: 'whatsapp',
        pin,
      },
    );
    return result.ok ? { ok: true, data: true } : result;
  }

  async subscribedApps(
    wabaId: string,
    token: string,
  ): Promise<GraphResult<SubscribedApp[]>> {
    const result = await this.request(
      'GET',
      `${wabaId}/subscribed_apps`,
      token,
    );
    if (!result.ok) {
      return result;
    }
    const data = Array.isArray(result.data['data']) ? result.data['data'] : [];
    return {
      ok: true,
      data: (data as Json[]).map((item) => {
        const app = (item['whatsapp_business_api_data'] ?? {}) as Json;
        return { id: String(app['id']), name: str(app['name']) };
      }),
    };
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: Json,
  ): Promise<GraphResult<Json>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      return {
        ok: false,
        error: {
          code: 'network_error',
          subcode: null,
          httpStatus: null,
          message: 'request failed or timed out',
        },
      };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const json = (
      payload && typeof payload === 'object' ? payload : {}
    ) as Json;
    if (response.ok) {
      return { ok: true, data: json };
    }
    const error = (json['error'] ?? {}) as Json;
    return {
      ok: false,
      error: {
        code:
          typeof error['code'] === 'number' ? error['code'] : response.status,
        subcode:
          typeof error['error_subcode'] === 'number'
            ? error['error_subcode']
            : null,
        httpStatus: response.status,
        message:
          typeof error['message'] === 'string'
            ? error['message'].slice(0, MAX_ERROR_MESSAGE_LENGTH)
            : `http ${response.status}`,
      },
    };
  }
}
