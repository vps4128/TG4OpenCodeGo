import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import type { Notifier } from '../src/notifier.js';
import { Scheduler } from '../src/scheduler.js';
import type { UsageCoordinator } from '../src/usage-coordinator.js';

const config: AppConfig = {
  telegramBotToken: 'test-token',
  allowedUserIds: [],
  opencodeApiKey: 'test-key',
  opencodeBaseUrl: 'https://opencode.ai',
  opencodeUsagePath: '/inference/go/v1/usage',
  defaultTz: 'Asia/Shanghai',
  defaultPushTimes: ['09:00'],
  checkIntervalMin: 15,
  checkIntervalMs: 900_000,
  alertThresholds: [50, 80],
  sqlitePath: ':memory:',
  healthFile: '/tmp/oc-tg-scheduler-test.heartbeat',
  telegramHealthFile: '/tmp/oc-tg-scheduler-test.telegram-heartbeat',
  logLevel: 'silent',
};

let store: Store | undefined;
let scheduler: Scheduler | undefined;

afterEach(() => {
  scheduler?.stop();
  store?.close();
  scheduler = undefined;
  store = undefined;
});

function createScheduler(current: Store): Scheduler {
  return new Scheduler({
    config,
    store: current,
    coordinator: {} as UsageCoordinator,
    notifier: {} as Notifier,
    logger: createLogger('silent'),
  });
}

describe('Scheduler', () => {
  it('registers jobs and returns the next run time', () => {
    store = new Store(':memory:', {
      tz: 'Asia/Shanghai',
      pushTimes: ['09:00'],
      thresholds: [50, 80],
    });
    store.upsertChat({ chatId: 1, userId: 1, title: null, isPrivate: true });

    scheduler = createScheduler(store);
    scheduler.rebuildAll();

    const next = scheduler.nextRun(1);
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(Date.now());
  });

  it('has no jobs when push is disabled', () => {
    store = new Store(':memory:', {
      tz: 'Asia/Shanghai',
      pushTimes: ['09:00'],
      thresholds: [50, 80],
    });
    store.upsertChat({ chatId: 1, userId: 1, title: null, isPrivate: true });
    store.setPushEnabled(1, false);

    scheduler = createScheduler(store);
    scheduler.rebuildAll();

    expect(scheduler.nextRun(1)).toBeNull();
  });

  it('ignores invalid stored times without throwing', () => {
    store = new Store(':memory:', {
      tz: 'Asia/Shanghai',
      pushTimes: ['09:00'],
      thresholds: [50, 80],
    });
    store.upsertChat({ chatId: 1, userId: 1, title: null, isPrivate: true });
    store.setTimes(1, ['25:99']);

    scheduler = createScheduler(store);
    expect(() => scheduler!.rebuildAll()).not.toThrow();
    expect(scheduler.nextRun(1)).toBeNull();
  });
});
