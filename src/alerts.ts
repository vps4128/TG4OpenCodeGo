import { escapeHtml, formatReset } from './format.js';
import {
  WINDOW_LABELS,
  WINDOW_NAMES,
  type UsageSnapshot,
  type WindowName,
} from './types.js';

export interface ThresholdCrossing {
  window: WindowName;
  threshold: number;
  percent: number;
  resetsAt: string;
}

export interface CriticalEvent {
  window: WindowName;
  kind: 'limit' | 'status';
  /** 用于告警去重的键：100 表示额度用尽，-1 表示状态异常。 */
  key: number;
  percent: number | null;
  status: string;
  resetsAt: string;
}

/**
 * 计算本次快照相比上一次快照新跨过的阈值。
 * 只在同一重置周期内比较，跨周期不会误报。
 */
export function computeCrossings(
  previous: UsageSnapshot | null,
  current: UsageSnapshot,
  thresholds: number[],
): ThresholdCrossing[] {
  if (!previous) return [];

  const crossings: ThresholdCrossing[] = [];
  for (const window of WINDOW_NAMES) {
    const oldUsage = previous.windows[window];
    const newUsage = current.windows[window];

    if (oldUsage.percent === null || newUsage.percent === null) continue;
    if (!oldUsage.resetsAt || !newUsage.resetsAt) continue;
    if (oldUsage.resetsAt !== newUsage.resetsAt) continue;

    for (const threshold of thresholds) {
      if (oldUsage.percent < threshold && newUsage.percent >= threshold) {
        crossings.push({
          window,
          threshold,
          percent: newUsage.percent,
          resetsAt: newUsage.resetsAt,
        });
      }
    }
  }
  return crossings;
}

/** 找出额度用尽或状态异常的窗口。 */
export function computeCritical(current: UsageSnapshot): CriticalEvent[] {
  const events: CriticalEvent[] = [];

  for (const window of WINDOW_NAMES) {
    const usage = current.windows[window];
    if (!usage.resetsAt) continue;

    if (usage.percent !== null && usage.percent >= 100) {
      events.push({
        window,
        kind: 'limit',
        key: 100,
        percent: usage.percent,
        status: usage.status,
        resetsAt: usage.resetsAt,
      });
    }
    if (usage.status !== 'ok') {
      events.push({
        window,
        kind: 'status',
        key: -1,
        percent: usage.percent,
        status: usage.status,
        resetsAt: usage.resetsAt,
      });
    }
  }
  return events;
}

export function formatThresholdAlert(crossing: ThresholdCrossing, timeZone: string): string {
  const label = WINDOW_LABELS[crossing.window];
  return [
    '⚠️ <b>OpenCode Go 用量提醒</b>',
    '',
    `<b>${label}</b> 已用 <b>${Math.round(crossing.percent)}%</b>，达到 <b>${crossing.threshold}%</b> 阈值。`,
    `🕐 ${formatReset(crossing.resetsAt, timeZone, crossing.window)}`,
    '',
    '发送 /usage 查看完整用量。',
  ].join('\n');
}

export function formatCriticalAlert(event: CriticalEvent, timeZone: string): string {
  const label = WINDOW_LABELS[event.window];
  const reset = `🕐 ${formatReset(event.resetsAt, timeZone, event.window)}`;

  if (event.kind === 'limit') {
    return [
      '🚨 <b>OpenCode Go 额度告警</b>',
      '',
      `<b>${label}</b> 已用 <b>${event.percent === null ? '100' : Math.round(event.percent)}%</b>，可能已无法继续请求。`,
      reset,
    ].join('\n');
  }

  return [
    '⚠️ <b>OpenCode Go 状态异常</b>',
    '',
    `<b>${label}</b> 状态：<code>${escapeHtml(event.status)}</code>`,
    reset,
  ].join('\n');
}
