import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  escapeHtml,
  formatDuration,
  formatReset,
  formatTimestamp,
  formatUsageCard,
  progressBar,
} from '../src/format.js';
import type { UsageSnapshot } from '../src/types.js';

function snapshot(percentages: [number, number, number] = [0, 21, 10]): UsageSnapshot {
  return {
    fetchedAt: '2026-10-22T15:22:00.000Z',
    windows: {
      rolling: {
        status: 'ok',
        percent: percentages[0],
        resetsAt: '2026-10-22T20:22:09.000Z',
      },
      weekly: {
        status: 'ok',
        percent: percentages[1],
        resetsAt: '2026-10-26T00:00:00.000Z',
      },
      monthly: {
        status: 'ok',
        percent: percentages[2],
        resetsAt: '2026-11-20T03:52:39.000Z',
      },
    },
    raw: null,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('progressBar', () => {
  it('renders 10 cells', () => {
    expect(progressBar(0)).toBe('░'.repeat(10));
    expect(progressBar(100)).toBe('█'.repeat(10));
  });

  it('rounds to the nearest cell', () => {
    expect(progressBar(21)).toBe(`${'█'.repeat(2)}${'░'.repeat(8)}`);
  });

  it('clamps out-of-range values', () => {
    expect(progressBar(150)).toBe('█'.repeat(10));
    expect(progressBar(-5)).toBe('░'.repeat(10));
  });

  it('handles null', () => {
    expect(progressBar(null)).toBe('░'.repeat(10));
  });
});

describe('formatDuration', () => {
  it('formats days and hours', () => {
    expect(formatDuration(3 * 86_400_000 + 8 * 3_600_000)).toBe('3天8小时');
  });

  it('formats sub-minute durations', () => {
    expect(formatDuration(30_000)).toBe('不到1分钟');
  });
});

describe('time formatting', () => {
  it('formats timestamps in the target timezone', () => {
    const date = new Date('2026-10-22T15:22:00.000Z');
    expect(formatTimestamp(date, 'Asia/Shanghai')).toBe('2026-10-22 23:22 (GMT+8)');
  });

  it('formats reset time and countdown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T15:22:00.000Z'));
    const result = formatReset('2026-10-22T20:22:09.000Z', 'Asia/Shanghai', 'rolling');
    expect(result).toContain('04:22 重置');
    expect(result).toContain('5小时');
  });
});

describe('escapeHtml', () => {
  it('escapes markup characters', () => {
    expect(escapeHtml('<b>&"')).toBe('&lt;b&gt;&amp;&quot;');
  });
});

describe('formatUsageCard', () => {
  it('contains usage, status and push settings', () => {
    const text = formatUsageCard(snapshot(), {
      tz: 'Asia/Shanghai',
      pushEnabled: true,
      pushTimes: ['09:00'],
      thresholds: [50, 80, 95, 100],
    });

    expect(text).toContain('OpenCode Go 用量');
    expect(text).toContain('21%');
    expect(text).toContain('本周');
    expect(text).toContain('09:00');
    expect(text).toContain('50/80/95/100%');
    expect(text).toContain('🟢');
  });

  it('marks stale data', () => {
    const text = formatUsageCard(snapshot(), {
      tz: 'Asia/Shanghai',
      pushEnabled: false,
      pushTimes: ['09:00'],
      thresholds: [],
      stale: true,
      error: '网络错误',
    });

    expect(text).toContain('数据可能已过期');
    expect(text).toContain('网络错误');
    expect(text).toContain('🔕');
    expect(text).toContain('阈值告警：关闭');
  });
});
