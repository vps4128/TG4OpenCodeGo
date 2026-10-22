import { UsageApiError } from './opencode.js';
import { WINDOW_LABELS, WINDOW_NAMES, type UsageSnapshot, type WindowName } from './types.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function progressBar(percent: number | null, width = 10): string {
  if (percent === null || !Number.isFinite(percent)) {
    return '░'.repeat(width);
  }
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function dateParts(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const result: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') result[part.type] = part.value;
  }
  return result;
}

function timeZoneOffset(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? 'UTC';
}

export function formatTimestamp(date: Date, timeZone: string): string {
  if (Number.isNaN(date.getTime())) return '—';
  const p = dateParts(date, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} (${timeZoneOffset(date, timeZone)})`;
}

export function formatClock(date: Date, timeZone: string): string {
  if (Number.isNaN(date.getTime())) return '—';
  const p = dateParts(date, timeZone);
  return `${p.hour}:${p.minute}`;
}

export function formatMonthDayTime(date: Date, timeZone: string): string {
  if (Number.isNaN(date.getTime())) return '—';
  const p = dateParts(date, timeZone);
  const now = dateParts(new Date(), timeZone);
  const year = p.year !== now.year ? `${p.year}-` : '';
  return `${year}${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '即将';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return '不到1分钟';

  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分`);
  return parts.length > 0 ? parts.join('') : '不到1分钟';
}

export function formatAge(iso: string | null): string {
  if (!iso) return '暂无数据';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '暂无数据';

  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function formatReset(
  resetsAt: string | null,
  timeZone: string,
  window: WindowName,
): string {
  if (!resetsAt) return '重置时间未知';
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return '重置时间未知';

  const label =
    window === 'rolling'
      ? formatClock(date, timeZone)
      : formatMonthDayTime(date, timeZone);
  const remaining = date.getTime() - Date.now();
  return remaining > 0
    ? `${label} 重置（${formatDuration(remaining)}后）`
    : `${label} 已重置`;
}

function percentText(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return '—';
  return `${Math.round(percent)}%`;
}

function statusInfo(snapshot: UsageSnapshot): {
  emoji: string;
  text: string;
  issues: { window: WindowName; status: string }[];
} {
  const issues: { window: WindowName; status: string }[] = [];
  let maxPercent = 0;

  for (const window of WINDOW_NAMES) {
    const usage = snapshot.windows[window];
    if (usage.status !== 'ok') {
      issues.push({ window, status: usage.status });
    }
    if (usage.percent !== null && usage.percent > maxPercent) {
      maxPercent = usage.percent;
    }
  }

  if (issues.length > 0) {
    const detail = issues
      .map((issue) => `${WINDOW_LABELS[issue.window]} ${issue.status}`)
      .join('、');
    return { emoji: '⚠️', text: `状态异常：${detail}`, issues };
  }
  if (maxPercent >= 100) return { emoji: '🚨', text: '额度可能已用尽', issues };
  if (maxPercent >= 80) return { emoji: '🔴', text: '状态正常', issues };
  if (maxPercent >= 50) return { emoji: '🟡', text: '状态正常', issues };
  return { emoji: '🟢', text: '状态正常', issues };
}

export interface UsageCardOptions {
  tz: string;
  pushEnabled: boolean;
  pushTimes: string[];
  thresholds: number[];
  nextPush?: Date | null;
  stale?: boolean;
  error?: string;
}

export function formatUsageCard(
  snapshot: UsageSnapshot,
  options: UsageCardOptions,
): string {
  const fetched = new Date(snapshot.fetchedAt);
  const status = statusInfo(snapshot);

  const lines: string[] = [
    '📊 <b>OpenCode Go 用量</b>',
    `🕐 ${formatTimestamp(fetched, options.tz)}`,
    '',
  ];

  for (const window of WINDOW_NAMES) {
    const usage = snapshot.windows[window];
    const label = WINDOW_LABELS[window];
    const extra = usage.status !== 'ok' ? ` ⚠️ ${escapeHtml(usage.status)}` : '';
    lines.push(
      `<b>${label}</b>  <code>${progressBar(usage.percent)}</code>  <b>${percentText(usage.percent)}</b>${extra}`,
    );
    lines.push(`　↳ ${formatReset(usage.resetsAt, options.tz, window)}`);
  }

  lines.push('');
  lines.push(`${status.emoji} ${escapeHtml(status.text)} · 更新于 ${formatClock(fetched, options.tz)}`);

  if (options.stale) {
    lines.push('⚠️ <b>数据可能已过期</b>，最近一次刷新失败。');
  }
  if (options.error) {
    lines.push(`　${escapeHtml(options.error)}`);
  }

  lines.push(
    options.thresholds.length > 0
      ? `🚦 告警阈值：${options.thresholds.join('/')}%`
      : '🚦 阈值告警：关闭',
  );

  if (options.pushEnabled) {
    const next = options.nextPush
      ? ` · 下次 ${formatMonthDayTime(options.nextPush, options.tz)}`
      : '';
    lines.push(`🔔 定时推送：${options.pushTimes.join(', ')}${next}`);
  } else {
    lines.push('🔕 定时推送：关闭');
  }

  return lines.join('\n');
}

export function formatHistory(snapshots: UsageSnapshot[], timeZone: string): string {
  if (snapshots.length === 0) return '📈 暂无历史数据。';

  const lines = ['📈 <b>最近用量</b>', ''];
  for (const snapshot of snapshots) {
    const date = new Date(snapshot.fetchedAt);
    const p = (window: WindowName): string => percentText(snapshot.windows[window].percent);
    lines.push(
      `${formatMonthDayTime(date, timeZone)} · 5h ${p('rolling')} · 周 ${p('weekly')} · 月 ${p('monthly')}`,
    );
  }
  return lines.join('\n');
}

export function formatUsageError(err: unknown): string {
  if (err instanceof UsageApiError) {
    switch (err.kind) {
      case 'auth':
        return '🔑 API Key 无效或已被吊销，请在 OpenCode 控制台重新创建，并更新 OPENCODE_API_KEY。';
      case 'rate_limit':
        return '⏳ 请求过于频繁，请稍后再试。';
      case 'network':
        return '🌐 无法连接 opencode.ai，请检查服务器网络。';
      case 'server':
        return '🛠️ OpenCode 服务暂时不可用，请稍后重试。';
      case 'parse':
        return '📦 接口返回了无法解析的数据，可能接口有变动。';
      default:
        return `❌ 请求失败${err.status ? `（HTTP ${err.status}）` : ''}，请稍后重试。`;
    }
  }
  return '❌ 查询失败，请稍后重试。';
}
