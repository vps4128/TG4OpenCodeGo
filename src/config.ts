import path from 'node:path';
import { z } from 'zod';
import {
  parseThresholds,
  parseTimes,
  parseUserIds,
  validateTimeZone,
  SettingsError,
} from './settings.js';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface AppConfig {
  telegramBotToken: string;
  allowedUserIds: number[];
  opencodeApiKey: string;
  opencodeBaseUrl: string;
  opencodeUsagePath: string;
  defaultTz: string;
  defaultPushTimes: string[];
  checkIntervalMin: number;
  checkIntervalMs: number;
  alertThresholds: number[];
  sqlitePath: string;
  healthFile: string;
  telegramHealthFile: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10, '缺少 TELEGRAM_BOT_TOKEN'),
  OPENCODE_API_KEY: z.string().min(8, '缺少 OPENCODE_API_KEY'),
  OPENCODE_BASE_URL: z.string().min(1).default('https://opencode.ai'),
  OPENCODE_USAGE_PATH: z.string().min(1).default('/inference/go/v1/usage'),
  ALLOWED_USER_IDS: z.string().default(''),
  DEFAULT_TZ: z.string().default('Asia/Shanghai'),
  DEFAULT_PUSH_TIMES: z.string().default('09:00'),
  CHECK_INTERVAL_MIN: z.coerce.number().int().min(5).max(1440).default(15),
  ALERT_THRESHOLDS: z.string().default('50,80,95,100'),
  SQLITE_PATH: z.string().min(1).default('./data/tg4opencodego.db'),
  HEALTH_FILE: z.string().optional(),
  TELEGRAM_HEALTH_FILE: z.string().optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

/** 从环境变量加载并校验配置。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'ENV'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`配置无效：\n${details}`);
  }

  const raw = parsed.data;

  let baseUrl: string;
  try {
    const url = new URL(raw.OPENCODE_BASE_URL);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('protocol');
    }
    baseUrl = url.toString().replace(/\/+$/, '');
  } catch {
    throw new ConfigError(`OPENCODE_BASE_URL 不是有效的 URL：${raw.OPENCODE_BASE_URL}`);
  }

  try {
    const defaultTz = validateTimeZone(raw.DEFAULT_TZ);
    const defaultPushTimes = parseTimes(raw.DEFAULT_PUSH_TIMES);
    const alertThresholds = parseThresholds(raw.ALERT_THRESHOLDS);
    const allowedUserIds = parseUserIds(raw.ALLOWED_USER_IDS);
    const checkIntervalMin = raw.CHECK_INTERVAL_MIN;
    const sqlitePath = raw.SQLITE_PATH;
    const healthFile =
      raw.HEALTH_FILE && raw.HEALTH_FILE.trim() !== ''
        ? raw.HEALTH_FILE
        : path.join(path.dirname(sqlitePath), 'heartbeat');
    const telegramHealthFile =
      raw.TELEGRAM_HEALTH_FILE && raw.TELEGRAM_HEALTH_FILE.trim() !== ''
        ? raw.TELEGRAM_HEALTH_FILE
        : path.join(path.dirname(sqlitePath), 'telegram-heartbeat');

    return {
      telegramBotToken: raw.TELEGRAM_BOT_TOKEN.trim(),
      allowedUserIds,
      opencodeApiKey: raw.OPENCODE_API_KEY.trim(),
      opencodeBaseUrl: baseUrl,
      opencodeUsagePath: raw.OPENCODE_USAGE_PATH,
      defaultTz,
      defaultPushTimes,
      checkIntervalMin,
      checkIntervalMs: checkIntervalMin * 60_000,
      alertThresholds,
      sqlitePath,
      healthFile,
      telegramHealthFile,
      logLevel: raw.LOG_LEVEL,
    };
  } catch (err) {
    if (err instanceof SettingsError) {
      throw new ConfigError(`配置无效：${err.message}`);
    }
    throw err;
  }
}

/** 加载当前目录下的 .env；不存在时静默跳过。 */
export function loadDotEnv(file = '.env'): void {
  try {
    process.loadEnvFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
