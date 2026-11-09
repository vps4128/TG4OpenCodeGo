import fs from 'node:fs';
import path from 'node:path';
import { Bot } from 'grammy';
import { loadConfig, loadDotEnv } from './config.js';
import { Store } from './db.js';
import { createLogger } from './logger.js';
import { Notifier } from './notifier.js';
import { UsageClient } from './opencode.js';
import { UsageCoordinator } from './usage-coordinator.js';
import { Scheduler } from './scheduler.js';
import { registerBotHandlers, setBotCommands } from './bot.js';
import { createTelegramFetch } from './telegram-fetch.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const store = new Store(config.sqlitePath, {
    tz: config.defaultTz,
    pushTimes: config.defaultPushTimes,
    thresholds: config.alertThresholds,
  });

  const touchTelegramHeartbeat = (): void => {
    try {
      fs.mkdirSync(path.dirname(path.resolve(config.telegramHealthFile)), { recursive: true });
      fs.writeFileSync(config.telegramHealthFile, new Date().toISOString());
    } catch (err) {
      logger.warn({ err: String(err) }, 'failed to write telegram heartbeat');
    }
  };
  touchTelegramHeartbeat();

  const bot = new Bot(config.telegramBotToken, {
    client: {
      fetch: createTelegramFetch({ onLongPollSuccess: touchTelegramHeartbeat }),
    },
  });
  const notifier = new Notifier(bot, logger);
  const client = new UsageClient({
    apiKey: config.opencodeApiKey,
    baseUrl: config.opencodeBaseUrl,
    usagePath: config.opencodeUsagePath,
    logger,
  });
  const coordinator = new UsageCoordinator(
    client,
    store,
    notifier,
    logger,
    config.healthFile,
  );
  const scheduler = new Scheduler({ config, store, coordinator, notifier, logger });

  registerBotHandlers(bot, { config, store, coordinator, scheduler, logger });

  await bot.init();
  await setBotCommands(bot).catch((err) => {
    logger.warn({ err: String(err) }, 'failed to set bot commands');
  });

  scheduler.start();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    scheduler.stop();
    void bot.stop();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  logger.info(
    {
      baseUrl: config.opencodeBaseUrl,
      intervalMin: config.checkIntervalMin,
      allowedUsers: config.allowedUserIds.length,
      defaultPushTimes: config.defaultPushTimes,
      thresholds: config.alertThresholds,
    },
    'tg4opencodego starting',
  );

  try {
    await bot.start({
      onStart: (info) => logger.info({ username: info.username }, 'telegram long polling started'),
    });
  } finally {
    scheduler.stop();
    store.close();
    logger.info('tg4opencodego stopped');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
