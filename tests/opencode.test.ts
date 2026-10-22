import { describe, expect, it, vi } from 'vitest';
import { UsageApiError, UsageClient } from '../src/opencode.js';

function body(percentages: [number, number, number] = [0, 21, 10]) {
  return {
    usage: {
      rolling: {
        status: 'ok',
        percent: percentages[0],
        resetsAt: '2026-10-22T20:22:09.000Z',
      },
      weekly: {
        status: 'ok',
        percent: percentages[1],
        resetsAt: '2026-10-26T00:00:00.000Z',
      },
      monthly: {
        status: 'ok',
        percent: percentages[2],
        resetsAt: '2026-11-20T03:52:39.000Z',
      },
    },
  };
}

function response(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(fetchImpl: (...args: never[]) => Promise<Response>, overrides = {}) {
  return new UsageClient({
    apiKey: 'test-key',
    baseUrl: 'https://opencode.ai',
    usagePath: '/inference/go/v1/usage',
    retries: 0,
    retryDelaysMs: [0, 0],
    cacheTtlMs: 0,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides,
  });
}

describe('UsageClient', () => {
  it('parses a valid response', async () => {
    const fetchImpl = vi.fn(async () => response(body()));
    const snapshot = await client(fetchImpl).get();

    expect(snapshot.windows.weekly.percent).toBe(21);
    expect(snapshot.windows.monthly.resetsAt).toBe('2026-11-20T03:52:39.000Z');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://opencode.ai/inference/go/v1/usage');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
  });

  it('classifies 401 as auth and does not retry', async () => {
    const fetchImpl = vi.fn(async () => response({ error: 'Unauthorized' }, 401));
    const error = await client(fetchImpl).get().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UsageApiError);
    expect((error as UsageApiError).kind).toBe('auth');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 500 responses', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ error: 'oops' }, 500))
      .mockResolvedValueOnce(response(body()));
    const snapshot = await client(fetchImpl, { retries: 1 }).get();

    expect(snapshot.windows.rolling.percent).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries 429 and honours Retry-After', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ error: 'slow down' }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(response(body()));
    const snapshot = await client(fetchImpl, { retries: 1 }).get();

    expect(snapshot.windows.weekly.percent).toBe(21);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails on invalid JSON', async () => {
    const fetchImpl = vi.fn(async () => response('not json'));
    const error = await client(fetchImpl).get().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UsageApiError);
    expect((error as UsageApiError).kind).toBe('parse');
  });

  it('fails when a window is missing', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ usage: { rolling: { status: 'ok', percent: 1 } } }),
    );
    const error = await client(fetchImpl).get().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UsageApiError);
    expect((error as UsageApiError).kind).toBe('parse');
  });

  it('caches responses unless forced', async () => {
    const fetchImpl = vi.fn(async () => response(body()));
    const usage = client(fetchImpl, { cacheTtlMs: 60_000 });

    await usage.get();
    await usage.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await usage.get(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maps network failures', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const error = await client(fetchImpl).get().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UsageApiError);
    expect((error as UsageApiError).kind).toBe('network');
  });

  it('joins base URL and usage path without duplicate slashes', async () => {
    const fetchImpl = vi.fn(async () => response(body()));
    await client(fetchImpl, { baseUrl: 'https://opencode.ai/' }).get();

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://opencode.ai/inference/go/v1/usage');
  });
});
