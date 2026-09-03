import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

interface ApiRequestOptions<TBody> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: TBody;
  csrf?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  requestSchema?: TSchema;
  responseSchema?: TSchema;
}

interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
  };
}

class ApiClientError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export async function apiRequest<TResponse, TBody = never>(
  url: string,
  options: ApiRequestOptions<TBody> = {},
): Promise<TResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted === true) abort();

  try {
    if (
      options.body !== undefined
      && options.requestSchema !== undefined
      && !Value.Check(options.requestSchema, options.body)
    ) {
      throw new ApiClientError('API 요청이 공유 계약과 일치하지 않습니다.', 0, 'CLIENT_SCHEMA_MISMATCH');
    }
    const headers: Record<string, string> = {};
    const formDataBody = options.body instanceof FormData;
    if (options.body !== undefined && !formDataBody) headers['content-type'] = 'application/json';
    if (options.csrf === true) headers['x-sfud-csrf'] = readCookie('sfud_csrf') ?? '';
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      signal: controller.signal,
      headers,
      ...(options.body === undefined
        ? {}
        : { body: formDataBody ? options.body as FormData : JSON.stringify(options.body) }),
    });
    const payload = await parseResponse(response);
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('sfud:unauthorized'));
    }
    if (!response.ok) {
      const error = payload as ApiErrorPayload | undefined;
      throw new ApiClientError(
        error?.error?.message ?? `API 요청이 실패했습니다. (${response.status})`,
        response.status,
        error?.error?.code,
      );
    }
    if (options.responseSchema !== undefined && !Value.Check(options.responseSchema, payload)) {
      throw new ApiClientError(
        'API 응답이 공유 계약과 일치하지 않습니다.',
        response.status,
        'RESPONSE_SCHEMA_MISMATCH',
      );
    }
    return payload as TResponse;
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      throw new ApiClientError('API 응답이 올바른 JSON 형식이 아닙니다.', response.status);
    }
    return undefined;
  }
}

function readCookie(name: string): string | undefined {
  for (const cookie of document.cookie.split(';')) {
    const [key, ...value] = cookie.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join('='));
    } catch {
      return undefined;
    }
  }
  return undefined;
}
