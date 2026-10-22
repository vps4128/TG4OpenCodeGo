import { z } from 'zod';
import type { Logger } from './logger.js';
import { sleep, errorMessage } from './util.js';
import {
  WINDOW_NAMES,
  type UsageSnapshot,
  type WindowName,
  type WindowUsage,
} from './types.js';

export type ApiErrorKind = 'auth' | 'rate_limit' | 'network' | 'server' | 'parse' | 'http';

export class UsageApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'UsageApiError';
  }
}

const windowSchema = z.object({
  status: z.string().optional(),
  percent: z.number().nullable().optional(),
  resetsAt: z.string().nullable().optional(),
});

const responseSchema = z.object({
  usage: z.object({
    rolling: windowSchema,
    weekly: windowSchema,
    monthly: windowSchema,
  }),
});

type WindowPayload = z.infer<typeof windowSchema>;

function toWindowUsage(payload: WindowPayload): WindowUsage {
  const status = payload.status?.trim().toLowerCase();
  return {
    status: status && status !== '' ? status : 'unknown',
    percent:
      typeof payload.percent === 'number' && Number.isFinite(payload.percent)
        ? payload.percent
        : null,
    resetsAt: payload.resetsAt ?? null,
  };
}

export interface UsageClientOptions {
  apiKey: string;
  baseUrl: string;
  usagePath: string;
  timeoutMs?: number;
  retries?: number;
  retryDelaysMs?: number[];
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

function buildUsageUrl(baseUrl: string, usagePath: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const path = usagePath.startsWith('/') ? usagePath : `/${usagePath}`;
  return `${base}${path}`;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return undefined;
}

/**
 * OpenCode Go 用量客户端。
 * 负责超时、错误分类、重试、429 退避和短时缓存。
 */
export class UsageClient {
  private readonly fetchImpl: typeof fetch;
  private cache: { snapshot: UsageSnapshot; at: number } | null = null;
  private inflight: Promise<UsageSnapshot> | null = null;

  constructor(private readonly options: UsageClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async get(force = false): Promise<UsageSnapshot> {
    const ttl = this.options.cacheTtlMs ?? 20_000;
    if (!force && this.cache && Date.now() - this.cache.at < ttl) {
      return this.cache.snapshot;
    }
    if (this.inflight) return this.inflight;

    const request = this.fetchWithRetry()
      .then((snapshot) => {
        this.cache = { snapshot, at: Date.now() };
        return snapshot;
      })
      .finally(() => {
        this.inflight = null;
      });

    this.inflight = request;
    return request;
  }

  private async fetchWithRetry(): Promise<UsageSnapshot> {
    const retries = this.options.retries ?? 2;
    const delays = this.options.retryDelaysMs ?? [1000, 2000, 4000];
    let lastError: UsageApiError | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.fetchOnce();
      } catch (err) {
        const apiError =
          err instanceof UsageApiError
            ? err
            : new UsageApiError('network', errorMessage(err));

        lastError = apiError;
        const retriable =
          apiError.kind === 'network' ||
          apiError.kind === 'server' ||
          apiError.kind === 'rate_limit';

        if (!retriable || attempt === retries) throw apiError;

        const delay =
          apiError.kind === 'rate_limit'
            ? Math.min((apiError.retryAfterSec ?? 2) * 1000, 30_000)
            : (delays[attempt] ?? 1000 * 2 ** attempt);

        this.options.logger?.warn(
          { attempt: attempt + 1, kind: apiError.kind, delay, status: apiError.status },
          'usage API retry',
        );
        await sleep(delay);
      }
    }

    throw lastError ?? new UsageApiError('network', 'unknown error');
  }

  private async fetchOnce(): Promise<UsageSnapshot> {
    const url = buildUsageUrl(this.options.baseUrl, this.options.usagePath);
    const timeoutMs = this.options.timeoutMs ?? 10_000;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          Accept: 'application/json',
          'User-Agent': 'oc-tg/1.0',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new UsageApiError('network', `无法连接 OpenCode：${errorMessage(err)}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new UsageApiError('auth', 'API Key 无效或已过期', response.status);
    }
    if (response.status === 429) {
      throw new UsageApiError(
        'rate_limit',
        'OpenCode 请求限流',
        response.status,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }
    if (response.status >= 500) {
      throw new UsageApiError('server', `OpenCode 服务错误 ${response.status}`, response.status);
    }
    if (!response.ok) {
      throw new UsageApiError('http', `OpenCode 返回 HTTP ${response.status}`, response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new UsageApiError('parse', 'OpenCode 返回了非 JSON 数据');
    }

    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      throw new UsageApiError('parse', 'OpenCode 用量响应结构不符合预期');
    }

    const windows = {} as Record<WindowName, WindowUsage>;
    for (const window of WINDOW_NAMES) {
      windows[window] = toWindowUsage(parsed.data.usage[window]);
    }

    const logId = response.headers.get('x-opencode-log-id');
    if (logId) {
      this.options.logger?.debug({ logId }, 'usage API response');
    }

    return {
      fetchedAt: new Date().toISOString(),
      windows,
      raw: body,
    };
  }
}
