import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  WINDOW_NAMES,
  type UsageSnapshot,
  type WindowName,
  type WindowUsage,
} from './types.js';

export interface ChatRow {
  chat_id: number;
  user_id: number;
  title: string | null;
  tz: string;
  push_enabled: number;
  push_times: string;
  thresholds: string;
  is_private: number;
  blocked: number;
  created_at: string;
  updated_at: string;
}

export interface StoreDefaults {
  tz: string;
  pushTimes: string[];
  thresholds: number[];
}

type Row = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function toSnapshot(row: Row): UsageSnapshot {
  let statuses: Record<string, string> = {};
  try {
    statuses = JSON.parse(String(row.statuses ?? '{}')) as Record<string, string>;
  } catch {
    statuses = {};
  }

  const windows = {} as Record<WindowName, WindowUsage>;
  for (const window of WINDOW_NAMES) {
    const percentValue = row[`${window}_pct`];
    const resetValue = row[`${window}_reset`];
    windows[window] = {
      status: statuses[window] ?? 'unknown',
      percent:
        percentValue === null || percentValue === undefined
          ? null
          : Number(percentValue),
      resetsAt:
        resetValue === null || resetValue === undefined ? null : String(resetValue),
    };
  }

  let raw: unknown = null;
  try {
    raw = JSON.parse(String(row.raw_json ?? 'null'));
  } catch {
    raw = null;
  }

  return {
    fetchedAt: String(row.fetched_at),
    windows,
    raw,
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(
    file: string,
    private readonly defaults: StoreDefaults,
  ) {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id       INTEGER PRIMARY KEY,
        user_id       INTEGER NOT NULL,
        title         TEXT,
        tz            TEXT    NOT NULL,
        push_enabled  INTEGER NOT NULL DEFAULT 1,
        push_times    TEXT    NOT NULL,
        thresholds    TEXT    NOT NULL,
        is_private    INTEGER NOT NULL DEFAULT 0,
        blocked       INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        fetched_at    TEXT    NOT NULL,
        rolling_pct   INTEGER,
        weekly_pct    INTEGER,
        monthly_pct   INTEGER,
        rolling_reset TEXT,
        weekly_reset  TEXT,
        monthly_reset TEXT,
        statuses      TEXT    NOT NULL,
        raw_json      TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_fetched ON snapshots(fetched_at);

      CREATE TABLE IF NOT EXISTS alert_state (
        chat_id    INTEGER NOT NULL,
        window     TEXT    NOT NULL,
        resets_at  TEXT    NOT NULL,
        threshold  INTEGER NOT NULL,
        sent_at    TEXT    NOT NULL,
        PRIMARY KEY (chat_id, window, resets_at, threshold)
      );

      CREATE TABLE IF NOT EXISTS push_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id    INTEGER NOT NULL,
        kind       TEXT    NOT NULL,
        ok         INTEGER NOT NULL,
        error      TEXT,
        created_at TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  upsertChat(params: {
    chatId: number;
    userId: number;
    title: string | null;
    isPrivate: boolean;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO chats (
           chat_id, user_id, title, tz, push_enabled, push_times, thresholds,
           is_private, blocked, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           user_id = excluded.user_id,
           title = excluded.title,
           is_private = excluded.is_private,
           updated_at = excluded.updated_at`,
      )
      .run(
        params.chatId,
        params.userId,
        params.title,
        this.defaults.tz,
        params.isPrivate ? 1 : 0,
        this.defaults.pushTimes.join(','),
        this.defaults.thresholds.join(','),
        params.isPrivate ? 1 : 0,
        now,
        now,
      );
  }

  getChat(chatId: number): ChatRow | undefined {
    const row = this.db.prepare('SELECT * FROM chats WHERE chat_id = ?').get(chatId);
    return row as unknown as ChatRow | undefined;
  }

  listChats(): ChatRow[] {
    const rows = this.db.prepare('SELECT * FROM chats ORDER BY created_at ASC').all();
    return rows as unknown as ChatRow[];
  }

  setPushEnabled(chatId: number, enabled: boolean): void {
    this.db
      .prepare('UPDATE chats SET push_enabled = ?, updated_at = ? WHERE chat_id = ?')
      .run(enabled ? 1 : 0, nowIso(), chatId);
  }

  setTimes(chatId: number, times: string[]): void {
    this.db
      .prepare('UPDATE chats SET push_times = ?, updated_at = ? WHERE chat_id = ?')
      .run(times.join(','), nowIso(), chatId);
  }

  setThresholds(chatId: number, thresholds: number[]): void {
    this.db
      .prepare('UPDATE chats SET thresholds = ?, updated_at = ? WHERE chat_id = ?')
      .run(thresholds.join(','), nowIso(), chatId);
  }

  setTz(chatId: number, tz: string): void {
    this.db
      .prepare('UPDATE chats SET tz = ?, updated_at = ? WHERE chat_id = ?')
      .run(tz, nowIso(), chatId);
  }

  setBlocked(chatId: number, blocked: boolean): void {
    this.db
      .prepare('UPDATE chats SET blocked = ?, updated_at = ? WHERE chat_id = ?')
      .run(blocked ? 1 : 0, nowIso(), chatId);
  }

  getOwnerUserId(): number | null {
    const value = this.getMeta('owner_user_id');
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  setOwnerUserId(userId: number): void {
    this.setMeta('owner_user_id', String(userId));
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  insertSnapshot(snapshot: UsageSnapshot): void {
    const statuses: Record<string, string> = {};
    for (const window of WINDOW_NAMES) {
      statuses[window] = snapshot.windows[window].status;
    }

    this.db
      .prepare(
        `INSERT INTO snapshots (
           fetched_at, rolling_pct, weekly_pct, monthly_pct,
           rolling_reset, weekly_reset, monthly_reset, statuses, raw_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.fetchedAt,
        snapshot.windows.rolling.percent,
        snapshot.windows.weekly.percent,
        snapshot.windows.monthly.percent,
        snapshot.windows.rolling.resetsAt,
        snapshot.windows.weekly.resetsAt,
        snapshot.windows.monthly.resetsAt,
        JSON.stringify(statuses),
        JSON.stringify(snapshot.raw ?? null),
      );
  }

  getLatestSnapshot(): UsageSnapshot | null {
    const row = this.db
      .prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT 1')
      .get();
    return row ? toSnapshot(row as unknown as Row) : null;
  }

  getSnapshotByFetchedAt(fetchedAt: string): UsageSnapshot | null {
    const row = this.db
      .prepare('SELECT * FROM snapshots WHERE fetched_at = ? ORDER BY id DESC LIMIT 1')
      .get(fetchedAt);
    return row ? toSnapshot(row as unknown as Row) : null;
  }

  listSnapshots(limit = 10): UsageSnapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT ?')
      .all(Math.max(1, Math.min(100, limit)));
    return (rows as unknown as Row[]).map(toSnapshot);
  }

  lastFetchAt(): string | null {
    const row = this.db.prepare('SELECT MAX(fetched_at) AS fetched_at FROM snapshots').get();
    return row && row.fetched_at ? String(row.fetched_at) : null;
  }

  hasAlert(chatId: number, window: WindowName, resetsAt: string, threshold: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM alert_state
         WHERE chat_id = ? AND window = ? AND resets_at = ? AND threshold = ?`,
      )
      .get(chatId, window, resetsAt, threshold);
    return Boolean(row);
  }

  recordAlert(
    chatId: number,
    window: WindowName,
    resetsAt: string,
    threshold: number,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO alert_state (chat_id, window, resets_at, threshold, sent_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(chatId, window, resetsAt, threshold, nowIso());
  }

  logPush(chatId: number, kind: string, ok: boolean, error?: string | null): void {
    this.db
      .prepare(
        'INSERT INTO push_logs (chat_id, kind, ok, error, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(chatId, kind, ok ? 1 : 0, error ?? null, nowIso());
  }

  /** 清理旧快照、告警状态和推送日志。 */
  prune(days = 90): void {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM snapshots WHERE fetched_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM alert_state WHERE sent_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM push_logs WHERE created_at < ?').run(cutoff);
  }

  close(): void {
    this.db.close();
  }
}
