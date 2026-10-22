import { Cron } from 'croner';
import type { AppConfig } from './config.js';
import type { ChatRow, Store } from './db.js';
import type { Logger } from './logger.js';
import type { Notifier } from './notifier.js';
import type { UsageCoordinator } from './usage-coordinator.js';
import { formatUsageCard, formatUsageError } from './format.js';
import { parseThresholds, parseTimes, timeToCron } from './settings.js';
import type { UsageSnapshot } from './types.js';

export interface SchedulerDeps {
  config: AppConfig;
  store: Store;
  coordinator: UsageCoordinator;
  notifier: Notifier;
  logger: Logger;
}

export class Scheduler {
  private readonly jobs = new Map<number, Cron[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private pollRunning = false;
  private readonly pushing = new Set<number>();
  private lastPrune = 0;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    this.stopped = false;
    this.rebuildAll();

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.poll();
    }, 3000);
    this.startupTimer.unref?.();

    this.timer = setInterval(() => void this.poll(), this.deps.config.checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const jobs of this.jobs.values()) {
      for (const job of jobs) job.stop();
    }
    this.jobs.clear();
  }

  rebuildAll(): void {
    for (const chat of this.deps.store.listChats()) {
      this.rebuildChat(chat.chat_id);
    }
  }

  /** 重新为某个 chat 注册定时任务（修改时间/时区/开关后调用）。 */
  rebuildChat(chatId: number): void {
    for (const job of this.jobs.get(chatId) ?? []) job.stop();
    this.jobs.delete(chatId);

    const chat = this.deps.store.getChat(chatId);
    if (!chat || chat.blocked === 1 || chat.push_enabled !== 1) return;

    let times: string[];
    try {
      times = parseTimes(chat.push_times);
    } catch (err) {
      this.deps.logger.warn({ chatId, err: String(err) }, 'invalid push times');
      return;
    }

    try {
      const jobs = times.map(
        (time) =>
          new Cron(timeToCron(time), { timezone: chat.tz, protect: true }, () => {
            void this.scheduledPush(chatId);
          }),
      );
      this.jobs.set(chatId, jobs);
    } catch (err) {
      this.deps.logger.warn({ chatId, err: String(err) }, 'failed to schedule pushes');
    }
  }

  /** 返回该 chat 下一次定时推送时间。 */
  nextRun(chatId: number): Date | null {
    let next: Date | null = null;
    for (const job of this.jobs.get(chatId) ?? []) {
      const candidate = job.nextRun();
      if (candidate && (!next || candidate.getTime() < next.getTime())) {
        next = candidate;
      }
    }
    return next;
  }

  private async scheduledPush(chatId: number): Promise<void> {
    if (this.stopped || this.pushing.has(chatId)) return;
    this.pushing.add(chatId);

    try {
      const chat = this.deps.store.getChat(chatId);
      if (!chat || chat.blocked === 1 || chat.push_enabled !== 1) return;
      // Key 失效时暂停推送，owner 已收到错误通知。
      if (this.deps.coordinator.isAuthBlocked()) return;

      const times = this.safeTimes(chat);
      const thresholds = this.safeThresholds(chat);

      let snapshot: UsageSnapshot | null = null;
      let failure: unknown = null;
      try {
        snapshot = await this.deps.coordinator.refresh(false);
      } catch (err) {
        failure = err;
      }

      if (!snapshot) snapshot = this.deps.store.getLatestSnapshot();

      if (!snapshot) {
        const text = [
          '⚠️ <b>OpenCode Go 用量获取失败</b>',
          formatUsageError(failure),
          '',
          '请检查配置，或稍后发送 /usage 重试。',
        ].join('\n');
        await this.send(chatId, text, 'scheduled');
        return;
      }

      const text = formatUsageCard(snapshot, {
        tz: chat.tz,
        pushEnabled: true,
        pushTimes: times,
        thresholds,
        nextPush: this.nextRun(chatId),
        stale: failure !== null,
        error: failure ? formatUsageError(failure) : undefined,
      });
      await this.send(chatId, text, 'scheduled');
    } finally {
      this.pushing.delete(chatId);
    }
  }

  private async send(chatId: number, text: string, kind: string): Promise<void> {
    const result = await this.deps.notifier.send(chatId, text);
    this.deps.store.logPush(chatId, kind, result.ok, result.ok ? null : result.error);
    if (!result.ok && result.blocked) {
      this.deps.store.setBlocked(chatId, true);
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.pollRunning) return;
    this.pollRunning = true;

    try {
      if (Date.now() - this.lastPrune > 86_400_000) {
        this.deps.store.prune(90);
        this.lastPrune = Date.now();
      }
      await this.deps.coordinator.refresh(true);
    } catch (err) {
      this.deps.logger.warn({ err: String(err) }, 'usage poll failed');
      await this.deps.coordinator.notifyPollError(err);
    } finally {
      this.pollRunning = false;
    }
  }

  private safeTimes(chat: ChatRow): string[] {
    try {
      return parseTimes(chat.push_times);
    } catch {
      return this.deps.config.defaultPushTimes;
    }
  }

  private safeThresholds(chat: ChatRow): number[] {
    try {
      return parseThresholds(chat.thresholds);
    } catch {
      return [];
    }
  }
}
