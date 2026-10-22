export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_TIMES = 6;
const MAX_THRESHOLDS = 10;

/** 解析 `09:00,20:30` 形式的时间列表。 */
export function parseTimes(input: string): string[] {
  const values = input.split(/[\s,]+/).filter(Boolean);
  if (values.length === 0) {
    throw new SettingsError('请至少提供一个时间，例如 09:00 或 09:00,20:00');
  }
  if (values.length > MAX_TIMES) {
    throw new SettingsError(`最多设置 ${MAX_TIMES} 个推送时间`);
  }
  const invalid = values.filter((value) => !TIME_RE.test(value));
  if (invalid.length > 0) {
    throw new SettingsError(`时间格式不正确：${invalid.join(', ')}，应为 HH:MM（如 09:00）`);
  }
  return [...new Set(values)].sort();
}

/** 解析 `50,80,95` 形式的阈值列表；`off` 或空字符串表示关闭。 */
export function parseThresholds(input: string): number[] {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'off') return [];

  const values = trimmed.split(/[\s,]+/).filter(Boolean);
  if (values.length > MAX_THRESHOLDS) {
    throw new SettingsError(`最多设置 ${MAX_THRESHOLDS} 个阈值`);
  }

  const numbers: number[] = [];
  for (const value of values) {
    if (!/^\d{1,3}$/.test(value)) {
      throw new SettingsError(`阈值必须是 0-100 的整数：${value}`);
    }
    const threshold = Number(value);
    if (threshold < 0 || threshold > 100) {
      throw new SettingsError(`阈值必须在 0-100 之间：${value}`);
    }
    numbers.push(threshold);
  }
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/** 校验 IANA 时区名称，返回规范化后的时区。 */
export function validateTimeZone(input: string): string {
  const tz = input.trim();
  if (tz === '') throw new SettingsError('时区不能为空，例如 Asia/Shanghai');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new SettingsError(`无效的时区：${tz}`);
  }
  return tz;
}

/** 解析逗号分隔的 Telegram user id。 */
export function parseUserIds(input: string): number[] {
  const values = input.split(/[\s,]+/).filter(Boolean);
  const ids: number[] = [];
  for (const value of values) {
    if (!/^\d+$/.test(value)) {
      throw new SettingsError(`无效的 Telegram user id：${value}`);
    }
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new SettingsError(`无效的 Telegram user id：${value}`);
    }
    ids.push(id);
  }
  return [...new Set(ids)];
}

/** 将 `HH:MM` 转成 croner 可用的 5 段 cron 表达式。 */
export function timeToCron(time: string): string {
  if (!TIME_RE.test(time)) {
    throw new SettingsError(`时间格式不正确：${time}，应为 HH:MM`);
  }
  const [hour, minute] = time.split(':').map(Number);
  return `${minute} ${hour} * * *`;
}

export function formatTimes(times: string[]): string {
  return times.join(', ');
}
