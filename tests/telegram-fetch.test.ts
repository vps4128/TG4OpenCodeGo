import { describe, expect, it } from 'vitest';
import { createTelegramFetch } from '../src/telegram-fetch.js';

describe('createTelegramFetch', () => {
  it('aborts requests that exceed the timeout', async () => {
    let seen: AbortSignal | undefined;
    const baseFetch = (async (_input: unknown, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('timed out'));
        });
      });
      return new Response('{}');
    }) as unknown as typeof fetch;

    const wrapped = createTelegramFetch({ requestTimeoutMs: 10, fetchImpl: baseFetch });
    await expect(
      wrapped('https://api.telegram.org/bot123/sendMessage', {}),
    ).rejects.toThrow('timed out');
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(true);
  });

  it('bridges the caller signal to the underlying fetch', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const baseFetch = (async (_input: unknown, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
      return new Response('{}');
    }) as unknown as typeof fetch;

    const wrapped = createTelegramFetch({ requestTimeoutMs: 60_000, fetchImpl: baseFetch });
    const request = wrapped('https://api.telegram.org/bot123/sendMessage', {
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 20);
    await expect(request).rejects.toThrow('aborted');
    expect(seen?.aborted).toBe(true);
  });

  it('reports successful long polls only', async () => {
    let heartbeats = 0;
    const baseFetch = (async (input: unknown) => {
      const url = String(input);
      return new Response('{}', { status: url.includes('fail') ? 500 : 200 });
    }) as unknown as typeof fetch;

    const wrapped = createTelegramFetch({
      fetchImpl: baseFetch,
      onLongPollSuccess: () => {
        heartbeats++;
      },
    });

    await wrapped('https://api.telegram.org/bot123/getUpdates');
    expect(heartbeats).toBe(1);

    await wrapped('https://api.telegram.org/bot123/sendMessage');
    expect(heartbeats).toBe(1);

    await wrapped('https://api.telegram.org/bot123/fail/getUpdates');
    expect(heartbeats).toBe(1);
  });

  it('accepts URL and Request inputs', async () => {
    const urls: string[] = [];
    const baseFetch = (async (input: unknown) => {
      urls.push(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url,
      );
      return new Response('{}');
    }) as unknown as typeof fetch;

    const wrapped = createTelegramFetch({ fetchImpl: baseFetch });
    await wrapped(new URL('https://api.telegram.org/bot123/getMe'));
    await wrapped(new Request('https://api.telegram.org/bot123/getUpdates'));

    expect(urls).toEqual([
      'https://api.telegram.org/bot123/getMe',
      'https://api.telegram.org/bot123/getUpdates',
    ]);
  });
});
