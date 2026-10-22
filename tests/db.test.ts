import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import type { UsageSnapshot } from '../src/types.js';

const defaults = {
  tz: 'Asia/Shanghai',
  pushTimes: ['09:00'],
  thresholds: [50, 80, 95, 100],
};

function snapshot(fetchedAt: string, weekly = 21): UsageSnapshot {
  return {
    fetchedAt,
    windows: {
      rolling: { status: 'ok', percent: 0, resetsAt: '2026-10-22T20:22:09.000Z' },
      weekly: { status: 'ok', percent: weekly, resetsAt: '2026-10-26T00:00:00.000Z' },
      monthly: { status: 'ok', percent: 10, resetsAt: '2026-11-20T03:52:39.000Z' },
    },
    raw: { test: true },
  };
}

let store: Store | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

describe('Store', () => {
  it('creates chats with per-chat defaults', () => {
    store = new Store(':memory:', defaults);
    store.upsertChat({ chatId: 1, userId: 100, title: null, isPrivate: true });

    const chat = store.getChat(1);
    expect(chat).toBeDefined();
    expect(chat?.push_enabled).toBe(1);
    expect(chat!.push_times.split(',')).toEqual(['09:00']);
    expect(chat!.thresholds.split(',').map(Number)).toEqual([50, 80, 95, 100]);
  });

  it('keeps chat settings when the chat is seen again', () => {
    store = new Store(':memory:', defaults);
    store.upsertChat({ chatId: 1, userId: 100, title: null, isPrivate: true });
    store.setPushEnabled(1, false);
    store.setTimes(1, ['20:00']);

    store.upsertChat({ chatId: 1, userId: 100, title: 'new title', isPrivate: true });

    const chat = store.getChat(1);
    expect(chat?.push_enabled).toBe(0);
    expect(chat!.push_times.split(',')).toEqual(['20:00']);
    expect(chat?.title).toBe('new title');
  });

  it('stores and reads the owner', () => {
    store = new Store(':memory:', defaults);
    expect(store.getOwnerUserId()).toBeNull();
    store.setOwnerUserId(42);
    expect(store.getOwnerUserId()).toBe(42);
  });

  it('stores snapshots and returns the latest first', () => {
    store = new Store(':memory:', defaults);
    store.insertSnapshot(snapshot('2026-10-22T10:00:00.000Z', 10));
    store.insertSnapshot(snapshot('2026-10-22T11:00:00.000Z', 20));

    const latest = store.getLatestSnapshot();
    expect(latest?.fetchedAt).toBe('2026-10-22T11:00:00.000Z');
    expect(latest?.windows.weekly.percent).toBe(20);

    const list = store.listSnapshots(10);
    expect(list).toHaveLength(2);
    expect(list[0]?.fetchedAt).toBe('2026-10-22T11:00:00.000Z');
    expect(store.lastFetchAt()).toBe('2026-10-22T11:00:00.000Z');
  });

  it('deduplicates alerts by chat, window, reset period and threshold', () => {
    store = new Store(':memory:', defaults);
    const resetsAt = '2026-10-26T00:00:00.000Z';

    expect(store.hasAlert(1, 'weekly', resetsAt, 80)).toBe(false);
    store.recordAlert(1, 'weekly', resetsAt, 80);
    expect(store.hasAlert(1, 'weekly', resetsAt, 80)).toBe(true);

    store.recordAlert(1, 'weekly', resetsAt, 80);
    expect(store.hasAlert(1, 'weekly', '2026-11-02T00:00:00.000Z', 80)).toBe(false);
  });

  it('prunes old data', () => {
    store = new Store(':memory:', defaults);
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    store.insertSnapshot(snapshot(old));
    store.prune(90);

    expect(store.listSnapshots(10)).toHaveLength(0);
  });
});
