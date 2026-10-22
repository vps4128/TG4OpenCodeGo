import { describe, expect, it } from 'vitest';
import {
  computeCritical,
  computeCrossings,
  formatCriticalAlert,
  formatThresholdAlert,
} from '../src/alerts.js';
import type { UsageSnapshot, WindowUsage } from '../src/types.js';

function snapshot(
  percentages: [number, number, number],
  resets = '2026-10-26T00:00:00.000Z',
  status: [string, string, string] = ['ok', 'ok', 'ok'],
): UsageSnapshot {
  const values: WindowUsage[] = percentages.map((percent, index) => ({
    status: status[index] ?? 'ok',
    percent,
    resetsAt: resets,
  }));

  return {
    fetchedAt: '2026-10-22T15:22:00.000Z',
    windows: {
      rolling: values[0]!,
      weekly: values[1]!,
      monthly: values[2]!,
    },
    raw: null,
  };
}

describe('computeCrossings', () => {
  it('reports every threshold crossed in one jump', () => {
    const crossings = computeCrossings(snapshot([0, 40, 0]), snapshot([0, 85, 0]), [
      50, 80, 95,
    ]);
    expect(crossings.map((crossing) => crossing.threshold)).toEqual([50, 80]);
    expect(crossings.every((crossing) => crossing.window === 'weekly')).toBe(true);
  });

  it('returns nothing without a previous snapshot', () => {
    expect(computeCrossings(null, snapshot([0, 85, 0]), [50, 80])).toEqual([]);
  });

  it('does not compare across reset periods', () => {
    const previous = snapshot([0, 40, 0], '2026-10-19T00:00:00.000Z');
    const current = snapshot([0, 85, 0], '2026-10-26T00:00:00.000Z');
    expect(computeCrossings(previous, current, [50, 80])).toEqual([]);
  });

  it('ignores thresholds not crossed', () => {
    expect(computeCrossings(snapshot([0, 21, 0]), snapshot([0, 30, 0]), [50])).toEqual([]);
  });
});

describe('computeCritical', () => {
  it('reports exhausted windows', () => {
    const events = computeCritical(snapshot([0, 100, 0]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ window: 'weekly', kind: 'limit', key: 100 });
  });

  it('reports non-ok status', () => {
    const events = computeCritical(snapshot([0, 0, 30], '2026-11-20T00:00:00.000Z', [
      'ok',
      'limited',
      'ok',
    ]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ window: 'weekly', kind: 'status', key: -1 });
  });

  it('can report both limit and status', () => {
    const events = computeCritical(snapshot([0, 100, 0], '2026-10-26T00:00:00.000Z', [
      'ok',
      'limited',
      'ok',
    ]));
    expect(events).toHaveLength(2);
  });
});

describe('alert formatting', () => {
  it('formats a threshold alert', () => {
    const text = formatThresholdAlert(
      { window: 'weekly', threshold: 80, percent: 85, resetsAt: '2026-10-26T00:00:00.000Z' },
      'Asia/Shanghai',
    );
    expect(text).toContain('本周');
    expect(text).toContain('85%');
    expect(text).toContain('80%');
    expect(text).toContain('10-26 08:00');
  });

  it('formats a status alert with escaping', () => {
    const text = formatCriticalAlert(
      {
        window: 'monthly',
        kind: 'status',
        key: -1,
        percent: 30,
        status: '<bad>',
        resetsAt: '2026-11-20T00:00:00.000Z',
      },
      'Asia/Shanghai',
    );
    expect(text).toContain('&lt;bad&gt;');
    expect(text).not.toContain('<bad>');
  });
});
