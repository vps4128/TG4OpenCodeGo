import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import type { Notifier } from '../src/notifier.js';
import { UsageClient } from '../src/opencode.js';
import { UsageCoordinator } from '../src/usage-coordinator.js';

const healthFile = path.join(os.tmpdir(), `oc-tg-test-${process.pid}.heartbeat`);

function body(weekly: number) {
  return {
    usage: {
      rolling: {
        status: 'ok',
        percent: 0,
        resetsAt: '2026-10-22T20:22:09.000Z',
      },
      weekly: {
        status: 'ok',
        percent: weekly,
        resetsAt: '2026-10-26T00:00:00.000Z',
      },
      monthly: {
        status: 'ok',
        percent: 10,
        resetsAt: '2026-11-20T03:52:39.000Z',
      },
    },
  };
}

let store: Store | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  fs.rmSync(healthFile, { force: true });
});

describe('UsageCoordinator', () => {
  it('stores snapshots and sends alert only when a threshold is crossed', async () => {
    const responses = [body(40), body(85), body(85)];
    let index = 0;
    const fetchImpl = async () =>
      new Response(JSON.stringify(responses[Math.min(index++, responses.length - 1)]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const client = new UsageClient({
      apiKey: 'test-key',
      baseUrl: 'https://opencode.ai',
      usagePath: '/inference/go/v1/usage',
      retries: 0,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    store = new Store(':memory:', {
      tz: 'Asia/Shanghai',
      pushTimes: ['09:00'],
      thresholds: [50, 80],
    });
    store.setOwnerUserId(1);
    store.upsertChat({ chatId: 1, userId: 1, title: null, isPrivate: true });

    const sent: string[] = [];
    const notifier = {
      send: async (_chatId: number, text: string) => {
        sent.push(text);
        return { ok: true };
      },
    } as unknown as Notifier;

    const coordinator = new UsageCoordinator(
      client,
      store,
      notifier,
      createLogger('silent'),
      healthFile,
    );

    await coordinator.refresh(true);
    expect(sent).toHaveLength(0);

    await coordinator.refresh(true);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('50%');
    expect(sent[1]).toContain('80%');

    await coordinator.refresh(true);
    expect(sent).toHaveLength(2);

    expect(store.hasAlert(1, 'weekly', '2026-10-26T00:00:00.000Z', 50)).toBe(true);
    expect(store.hasAlert(1, 'weekly', '2026-10-26T00:00:00.000Z', 80)).toBe(true);
    expect(fs.existsSync(healthFile)).toBe(true);
  });

  it('retries alert delivery after a transient Telegram failure', async () => {
    const responses = [body(40), body(85), body(85)];
    let index = 0;
    const fetchImpl = async () =>
      new Response(JSON.stringify(responses[Math.min(index++, responses.length - 1)]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const client = new UsageClient({
      apiKey: 'test-key',
      baseUrl: 'https://opencode.ai',
      usagePath: '/inference/go/v1/usage',
      retries: 0,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    store = new Store(':memory:', {
      tz: 'Asia/Shanghai',
      pushTimes: ['09:00'],
      thresholds: [50, 80],
    });
    store.upsertChat({ chatId: 1, userId: 1, title: null, isPrivate: true });

    let calls = 0;
    let delivered = 0;
    const notifier = {
      send: async () => {
        calls++;
        if (calls <= 2) return { ok: false, blocked: false, error: 'temporary' };
        delivered++;
        return { ok: true };
      },
    } as unknown as Notifier;

    const coordinator = new UsageCoordinator(
      client,
      store,
      notifier,
      createLogger('silent'),
      healthFile,
    );

    await coordinator.refresh(true);
    await coordinator.refresh(true);
    expect(delivered).toBe(0);

    await coordinator.refresh(true);
    expect(delivered).toBe(2);
    expect(calls).toBe(4);
    expect(store.hasAlert(1, 'weekly', '2026-10-26T00:00:00.000Z', 80)).toBe(true);
  });

  it('marks auth failures and clears the flag after a successful refresh', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(body(10)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const client = new UsageClient({
      apiKey: 'bad-key',
      baseUrl: 'https://opencode.ai',
      usagePath: '/inference/go/v1/usage',
      retries: 0,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    store = new Store(':memory:', {
      tz: 'Asia/Shanghai',
      pushTimes: ['09:00'],
      thresholds: [],
    });

    const notifier = {
      send: async () => ({ ok: true }),
    } as unknown as Notifier;

    const coordinator = new UsageCoordinator(
      client,
      store,
      notifier,
      createLogger('silent'),
      healthFile,
    );

    await expect(coordinator.refresh(true)).rejects.toThrow();
    expect(coordinator.isAuthBlocked()).toBe(true);

    await coordinator.refresh(true);
    expect(coordinator.isAuthBlocked()).toBe(false);
  });

  it('sends a critical alert when a window is exhausted', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(body(100)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const client = new UsageClient({
      apiKey: 'test-key',
      baseUrl: 'https://opencode.ai',
      usagePath: '/inference/go/v1/usage',
      retries: 0,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    store = new Store(':memory:', {
      tz: 'Asia/Shanghai',
      pushTimes: ['09:00'],
      thresholds: [50, 80],
    });
    store.upsertChat({ chatId: 1, userId: 1, title: null, isPrivate: true });

    const sent: string[] = [];
    const notifier = {
      send: async (_chatId: number, text: string) => {
        sent.push(text);
        return { ok: true };
      },
    } as unknown as Notifier;

    const coordinator = new UsageCoordinator(
      client,
      store,
      notifier,
      createLogger('silent'),
      healthFile,
    );
    await coordinator.refresh(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('额度告警');
  });

  it('does not alert when thresholds are disabled', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(body(100)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const client = new UsageClient({
      apiKey: 'test-key',
      baseUrl: 'https://opencode.ai',
      usagePath: '/inference/go/v1/usage',
      retries: 0,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    store = new Store(':memory:', {
      tz: 'Asia/Shanghai',
      pushTimes: ['09:00'],
      thresholds: [],
    });
    store.upsertChat({ chatId: 1, userId: 1, title: null, isPrivate: true });

    const sent: string[] = [];
    const notifier = {
      send: async (_chatId: number, text: string) => {
        sent.push(text);
        return { ok: true };
      },
    } as unknown as Notifier;

    const coordinator = new UsageCoordinator(
      client,
      store,
      notifier,
      createLogger('silent'),
      healthFile,
    );
    await coordinator.refresh(true);

    expect(sent).toHaveLength(0);
  });
});
