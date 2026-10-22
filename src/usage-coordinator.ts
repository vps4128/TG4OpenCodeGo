import fs from 'node:fs';
import path from 'node:path';
import type { ChatRow, Store } from './db.js';
import type { Logger } from './logger.js';
import type { Notifier } from './notifier.js';
import { UsageApiError, type UsageClient } from './opencode.js';
import { parseThresholds } from './settings.js';
import { formatUsageError } from './format.js';
import {
  computeCritical,
  computeCrossings,
  formatCriticalAlert,
  formatThresholdAlert,
} from './alerts.js';
import type { UsageSnapshot, WindowName } from './types.js';

/**
 * 负责“拉取一次用量 → 存快照 → 评估阈值/异常告警”的完整流程。
 * 手动查询和定时轮询都走这里，保证告警不会因为查询入口不同而漏掉。
 */
const ALERT_BASELINE_KEY = 'last_alert_fetched_at';

export class UsageCoordinator {
  private readonly lastErrorNotice = new Map<string, number>();
  private authBlocked = false;

  constructor(
    private readonly client: UsageClient,
    private readonly store: Store,
    private readonly notifier: Notifier,
    private readonly logger: Logger,
    private readonly healthFile: string,
    private readonly errorCooldownMs = 3_600_000,
  ) {}

  /** Key 失效期间暂停定时推送，避免每个推送时间都发送失败消息。 */
  isAuthBlocked(): boolean {
    return this.authBlocked;
  }

  async refresh(force = false): Promise<UsageSnapshot> {
    let snapshot: UsageSnapshot;
    try {
      snapshot = await this.client.get(force);
    } catch (err) {
      if (err instanceof UsageApiError && err.kind === 'auth') {
        this.authBlocked = true;
      }
      throw err;
    }
    this.authBlocked = false;

    // 使用“上次成功评估告警时的快照”作为基准，而不是最新快照。
    // 这样某次告警发送失败后，下次轮询仍能重新检测到阈值跨越。
    const baselineAt = this.store.getMeta(ALERT_BASELINE_KEY);
    const previous =
      (baselineAt ? this.store.getSnapshotByFetchedAt(baselineAt) : null) ??
      this.store.getLatestSnapshot();

    if (!previous || previous.fetchedAt !== snapshot.fetchedAt) {
      this.store.insertSnapshot(snapshot);
    }

    const hadFailure = await this.evaluateAlerts(previous, snapshot);
    if (!hadFailure) {
      this.store.setMeta(ALERT_BASELINE_KEY, snapshot.fetchedAt);
    }

    this.writeHeartbeat();
    return snapshot;
  }

  private async evaluateAlerts(
    previous: UsageSnapshot | null,
    current: UsageSnapshot,
  ): Promise<boolean> {
    const chats = this.store.listChats();
    let hadTransientFailure = false;

    for (const chat of chats) {
      if (chat.blocked === 1) continue;

      let thresholds: number[];
      try {
        thresholds = parseThresholds(chat.thresholds);
      } catch {
        this.logger.warn({ chatId: chat.chat_id }, 'invalid threshold config, skipped');
        continue;
      }

      // 阈值列表为空表示用户关闭了全部主动告警。
      if (thresholds.length === 0) continue;

      for (const event of computeCritical(current)) {
        if (this.store.hasAlert(chat.chat_id, event.window, event.resetsAt, event.key)) {
          continue;
        }
        const outcome = await this.deliver(
          chat,
          event.window,
          event.resetsAt,
          event.key,
          formatCriticalAlert(event, chat.tz),
          'critical',
        );
        if (outcome === 'failed') hadTransientFailure = true;
      }

      for (const crossing of computeCrossings(previous, current, thresholds)) {
        // 100% 由 computeCritical 负责，避免同一事件发送两条消息。
        if (crossing.threshold >= 100) continue;
        if (
          this.store.hasAlert(
            chat.chat_id,
            crossing.window,
            crossing.resetsAt,
            crossing.threshold,
          )
        ) {
          continue;
        }
        const outcome = await this.deliver(
          chat,
          crossing.window,
          crossing.resetsAt,
          crossing.threshold,
          formatThresholdAlert(crossing, chat.tz),
          'threshold',
        );
        if (outcome === 'failed') hadTransientFailure = true;
      }
    }

    return hadTransientFailure;
  }

  private async deliver(
    chat: ChatRow,
    window: WindowName,
    resetsAt: string,
    key: number,
    text: string,
    kind: 'threshold' | 'critical',
  ): Promise<'ok' | 'blocked' | 'failed'> {
    const result = await this.notifier.send(chat.chat_id, text);
    if (result.ok) {
      this.store.recordAlert(chat.chat_id, window, resetsAt, key);
      this.store.logPush(chat.chat_id, kind, true);
      return 'ok';
    }

    this.store.logPush(chat.chat_id, kind, false, result.error);
    if (result.blocked) {
      this.store.setBlocked(chat.chat_id, true);
      return 'blocked';
    }
    return 'failed';
  }

  /** 拉取失败时通知 owner（优先私聊），同一类错误每小时最多一次。 */
  async notifyPollError(err: unknown): Promise<void> {
    const key = err instanceof UsageApiError ? err.kind : 'unknown';
    const now = Date.now();
    const last = this.lastErrorNotice.get(key) ?? 0;
    if (now - last < this.errorCooldownMs) return;
    this.lastErrorNotice.set(key, now);

    const chats = this.store.listChats();
    const ownerId = this.store.getOwnerUserId();
    let targets = chats.filter(
      (chat) => chat.blocked === 0 && chat.is_private === 1 && chat.user_id === ownerId,
    );
    if (targets.length === 0) {
      targets = chats.filter((chat) => chat.blocked === 0 && chat.push_enabled === 1);
    }

    const text = [
      '⚠️ <b>OpenCode Go 用量获取失败</b>',
      formatUsageError(err),
      '',
      '将按计划自动重试。',
    ].join('\n');

    for (const chat of targets) {
      const result = await this.notifier.send(chat.chat_id, text);
      if (!result.ok && result.blocked) this.store.setBlocked(chat.chat_id, true);
    }
  }

  private writeHeartbeat(): void {
    try {
      fs.mkdirSync(path.dirname(path.resolve(this.healthFile)), { recursive: true });
      fs.writeFileSync(this.healthFile, new Date().toISOString());
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'failed to write health heartbeat');
    }
  }
}
