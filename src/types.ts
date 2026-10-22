export const WINDOW_NAMES = ['rolling', 'weekly', 'monthly'] as const;

export type WindowName = (typeof WINDOW_NAMES)[number];

export interface WindowUsage {
  status: string;
  percent: number | null;
  resetsAt: string | null;
}

export interface UsageSnapshot {
  fetchedAt: string;
  windows: Record<WindowName, WindowUsage>;
  raw: unknown;
}

export const WINDOW_LABELS: Record<WindowName, string> = {
  rolling: '5 小时窗口',
  weekly: '本周',
  monthly: '本月',
};
