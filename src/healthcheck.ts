import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv } from './config.js';

/**
 * Docker healthcheck：最近一次成功拉取用量是否仍在允许时间内。
 * 心跳文件在每次成功拉取后由服务写入。
 */
function main(): void {
  loadDotEnv();

  const sqlitePath = process.env.SQLITE_PATH ?? './data/tg4opencodego.db';
  const healthFile =
    process.env.HEALTH_FILE && process.env.HEALTH_FILE.trim() !== ''
      ? process.env.HEALTH_FILE
      : path.join(path.dirname(sqlitePath), 'heartbeat');
  const telegramHealthFile =
    process.env.TELEGRAM_HEALTH_FILE && process.env.TELEGRAM_HEALTH_FILE.trim() !== ''
      ? process.env.TELEGRAM_HEALTH_FILE
      : path.join(path.dirname(sqlitePath), 'telegram-heartbeat');
  const intervalMin = Math.max(5, Number(process.env.CHECK_INTERVAL_MIN ?? 15) || 15);
  const usageMaxAgeMs = intervalMin * 3 * 60_000;
  // getUpdates 正常时每 30 秒左右返回一次；5 分钟无心跳视为轮询卡死。
  const pollMaxAgeMs = 5 * 60_000;

  checkHeartbeat(healthFile, usageMaxAgeMs, 'usage');
  checkHeartbeat(telegramHealthFile, pollMaxAgeMs, 'telegram polling');

  console.log('healthcheck: ok');
}

function checkHeartbeat(file: string, maxAgeMs: number, label: string): void {
  if (!fs.existsSync(file)) {
    console.error(`healthcheck: missing ${label} heartbeat file ${file}`);
    process.exit(1);
  }

  const ageMs = Date.now() - fs.statSync(file).mtimeMs;
  if (ageMs > maxAgeMs) {
    console.error(
      `healthcheck: ${label} heartbeat is stale (${Math.round(ageMs / 60_000)} min old, limit ${Math.round(maxAgeMs / 60_000)} min)`,
    );
    process.exit(1);
  }
}

main();
