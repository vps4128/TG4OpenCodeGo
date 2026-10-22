import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy';
import type { AppConfig } from './config.js';
import type { ChatRow, Store } from './db.js';
import type { Logger } from './logger.js';
import type { Scheduler } from './scheduler.js';
import type { UsageCoordinator } from './usage-coordinator.js';
import {
  formatAge,
  formatHistory,
  formatMonthDayTime,
  formatTimestamp,
  formatUsageCard,
  formatUsageError,
  type UsageCardOptions,
} from './format.js';
import {
  formatTimes,
  parseThresholds,
  parseTimes,
  SettingsError,
  validateTimeZone,
} from './settings.js';
import { WINDOW_LABELS, WINDOW_NAMES } from './types.js';
import { redactToken } from './util.js';

export interface BotDeps {
  config: AppConfig;
  store: Store;
  coordinator: UsageCoordinator;
  scheduler: Scheduler;
  logger: Logger;
}

const MANUAL_COOLDOWN_MS = 30_000;

function isStartCommand(text: string): boolean {
  return /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text);
}

function safeTimes(chat: ChatRow, deps: BotDeps): string[] {
  try {
    return parseTimes(chat.push_times);
  } catch {
    return deps.config.defaultPushTimes;
  }
}

function safeThresholds(chat: ChatRow): number[] {
  try {
    return parseThresholds(chat.thresholds);
  } catch {
    return [];
  }
}

function cardOptions(
  chat: ChatRow,
  deps: BotDeps,
  extra: Partial<UsageCardOptions> = {},
): UsageCardOptions {
  return {
    tz: chat.tz,
    pushEnabled: chat.push_enabled === 1,
    pushTimes: safeTimes(chat, deps),
    thresholds: safeThresholds(chat),
    nextPush: deps.scheduler.nextRun(chat.chat_id),
    ...extra,
  };
}

function keyboard(chat: ChatRow): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 刷新', 'refresh')
    .text(chat.push_enabled === 1 ? '🔕 关闭推送' : '🔔 开启推送', 'toggle_push')
    .row()
    .text('📈 历史', 'history');
}

function isNotModifiedError(err: unknown): boolean {
  return err instanceof GrammyError && err.description.includes('message is not modified');
}

function helpText(): string {
  return [
    '🤖 <b>OpenCode Go 用量机器人</b>',
    '',
    '📊 <b>查询</b>',
    '/usage — 查询当前三个窗口用量',
    '/history — 最近 10 次用量记录',
    '/status — 查看当前配置和运行状态',
    '/test — 立即发送一条测试消息',
    '',
    '🔔 <b>推送</b>',
    '/subscribe — 开启定时推送',
    '/unsubscribe — 关闭定时推送',
    '/times 09:00,20:00 — 设置每日推送时间',
    '/times default — 恢复默认时间',
    '/threshold 50,80,95,100 — 设置告警阈值',
    '/threshold off — 关闭阈值告警',
    '/tz Asia/Shanghai — 设置时区',
    '',
    '/id — 查看 chat id / user id',
  ].join('\n');
}

export function registerBotHandlers(bot: Bot, deps: BotDeps): void {
  const { config, store, coordinator, scheduler, logger } = deps;
  const manualRefreshes = new Map<number, number>();

  function checkManualCooldown(chatId: number): number {
    const last = manualRefreshes.get(chatId) ?? 0;
    const remaining = MANUAL_COOLDOWN_MS - (Date.now() - last);
    if (remaining > 0) return Math.ceil(remaining / 1000);
    manualRefreshes.set(chatId, Date.now());
    return 0;
  }

  bot.catch((err) => {
    const detail = err.error instanceof Error
      ? `${err.error.name}: ${err.error.message}`
      : String(err.error);
    logger.error(
      { err: redactToken(detail), updateId: err.ctx?.update?.update_id },
      'bot handler error',
    );
  });

  // 权限与 owner 绑定
  bot.use(async (ctx, next) => {
    const updateType = Object.keys(ctx.update).find((key) => key !== 'update_id');
    logger.debug({ updateType }, 'update received');

    const from = ctx.from;
    if (!from) return;

    const chat = ctx.chat;
    const text = ctx.message?.text ?? '';
    const ownerId = store.getOwnerUserId();
    let allowed =
      config.allowedUserIds.length > 0
        ? config.allowedUserIds.includes(from.id)
        : ownerId === from.id;

    if (
      !allowed &&
      config.allowedUserIds.length === 0 &&
      ownerId === null &&
      chat?.type === 'private' &&
      isStartCommand(text)
    ) {
      store.setOwnerUserId(from.id);
      allowed = true;
      logger.info({ userId: from.id }, 'owner bound');
    }

    if (!allowed) {
      if (chat?.type === 'private') {
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({ text: '未授权', show_alert: true }).catch(() => {});
        } else {
          await ctx.reply(
            [
              '⛔ 未授权。',
              '',
              `你的 user id：<code>${from.id}</code>`,
              '请让 owner 把它加入 ALLOWED_USER_IDS。',
            ].join('\n'),
            { parse_mode: 'HTML' },
          );
        }
      }
      return;
    }

    if (store.getOwnerUserId() === null) {
      store.setOwnerUserId(from.id);
    }

    if (chat) {
      const existing = store.getChat(chat.id);
      store.upsertChat({
        chatId: chat.id,
        userId: from.id,
        title: 'title' in chat ? (chat.title ?? null) : null,
        isPrivate: chat.type === 'private',
      });

      // 用户重新与机器人交互时，解除此前的 403 屏蔽状态。
      if (existing?.blocked === 1) {
        store.setBlocked(chat.id, false);
        scheduler.rebuildChat(chat.id);
      }
    }

    await next();
  });

  bot.command('start', async (ctx) => {
    const from = ctx.from;
    const chat = ctx.chat;
    await ctx.reply(
      [
        '👋 <b>OpenCode Go 用量机器人</b>',
        '',
        '可以随时查询订阅额度，也会按计划主动推送。',
        '',
        '/usage — 查询用量',
        '/subscribe — 开启定时推送',
        '/times 09:00,20:00 — 设置推送时间',
        '/threshold 50,80,95 — 设置阈值',
        '/help — 查看全部命令',
        '',
        `你的 user id：<code>${from?.id ?? '—'}</code>`,
        `当前 chat id：<code>${chat?.id ?? '—'}</code>`,
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(helpText(), { parse_mode: 'HTML' });
  });

  bot.command('id', async (ctx) => {
    await ctx.reply(
      [
        `chat id：<code>${ctx.chat?.id ?? '—'}</code>`,
        `user id：<code>${ctx.from?.id ?? '—'}</code>`,
        `chat 类型：<code>${ctx.chat?.type ?? '—'}</code>`,
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('usage', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    const wait = checkManualCooldown(chatId);
    if (wait > 0) {
      await ctx.reply(`⏳ 刷新太频繁，请 ${wait} 秒后再试。`);
      return;
    }

    await ctx.replyWithChatAction('typing').catch(() => {});
    try {
      const snapshot = await coordinator.refresh(false);
      const chat = store.getChat(chatId);
      if (!chat) return;
      await ctx.reply(formatUsageCard(snapshot, cardOptions(chat, deps)), {
        parse_mode: 'HTML',
        reply_markup: keyboard(chat),
      });
    } catch (err) {
      await ctx.reply(formatUsageError(err), { parse_mode: 'HTML' });
    }
  });

  bot.command('test', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    await ctx.replyWithChatAction('typing').catch(() => {});
    try {
      const snapshot = await coordinator.refresh(true);
      const chat = store.getChat(chatId);
      if (!chat) return;
      await ctx.reply(`🧪 测试消息\n\n${formatUsageCard(snapshot, cardOptions(chat, deps))}`, {
        parse_mode: 'HTML',
        reply_markup: keyboard(chat),
      });
    } catch (err) {
      await ctx.reply(formatUsageError(err), { parse_mode: 'HTML' });
    }
  });

  bot.command('subscribe', async (ctx) => {
    const chat = ctx.chat ? store.getChat(ctx.chat.id) : undefined;
    if (!chat) return;

    store.setPushEnabled(chat.chat_id, true);
    scheduler.rebuildChat(chat.chat_id);
    const updated = store.getChat(chat.chat_id) ?? chat;
    const next = scheduler.nextRun(chat.chat_id);

    await ctx.reply(
      [
        '🔔 已开启定时推送。',
        `时间：${formatTimes(safeTimes(updated, deps))}（${updated.tz}）`,
        next ? `下次推送：${formatMonthDayTime(next, updated.tz)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  });

  bot.command('unsubscribe', async (ctx) => {
    const chat = ctx.chat ? store.getChat(ctx.chat.id) : undefined;
    if (!chat) return;

    store.setPushEnabled(chat.chat_id, false);
    scheduler.rebuildChat(chat.chat_id);
    const thresholds = safeThresholds(chat);

    await ctx.reply(
      [
        '🔕 已关闭定时推送。',
        thresholds.length > 0
          ? `阈值告警仍然开启（${thresholds.join('/')}%），发送 /threshold off 可一并关闭。`
          : '阈值告警当前也是关闭状态。',
      ].join('\n'),
    );
  });

  bot.command('times', async (ctx) => {
    const chat = ctx.chat ? store.getChat(ctx.chat.id) : undefined;
    if (!chat) return;

    const arg = ctx.match.trim();
    if (arg === '') {
      const times = safeTimes(chat, deps);
      const next = scheduler.nextRun(chat.chat_id);
      await ctx.reply(
        [
          `当前推送时间：${formatTimes(times)}（${chat.tz}）`,
          next ? `下次推送：${formatMonthDayTime(next, chat.tz)}` : '当前未开启推送',
          '',
          '修改示例：/times 09:00,20:00',
        ].join('\n'),
      );
      return;
    }

    try {
      const times = arg.toLowerCase() === 'default' ? config.defaultPushTimes : parseTimes(arg);
      store.setTimes(chat.chat_id, times);
      scheduler.rebuildChat(chat.chat_id);
      const updated = store.getChat(chat.chat_id) ?? chat;
      const next = scheduler.nextRun(chat.chat_id);
      await ctx.reply(
        [
          `✅ 推送时间已更新：${formatTimes(times)}（${updated.tz}）`,
          next ? `下次推送：${formatMonthDayTime(next, updated.tz)}` : '发送 /subscribe 开启推送',
        ].join('\n'),
      );
    } catch (err) {
      if (err instanceof SettingsError) {
        await ctx.reply(`❌ ${err.message}`);
        return;
      }
      throw err;
    }
  });

  bot.command('threshold', async (ctx) => {
    const chat = ctx.chat ? store.getChat(ctx.chat.id) : undefined;
    if (!chat) return;

    const arg = ctx.match.trim();
    if (arg === '') {
      const thresholds = safeThresholds(chat);
      await ctx.reply(
        thresholds.length > 0
          ? `当前告警阈值：${thresholds.join('/')}%\n修改示例：/threshold 50,80,95,100`
          : '阈值告警当前已关闭。\n开启示例：/threshold 50,80,95,100',
      );
      return;
    }

    try {
      const thresholds = parseThresholds(arg);
      store.setThresholds(chat.chat_id, thresholds);
      await ctx.reply(
        thresholds.length > 0
          ? `✅ 告警阈值已更新：${thresholds.join('/')}%`
          : '✅ 已关闭阈值告警（包括 100% 和状态异常通知）。',
      );
    } catch (err) {
      if (err instanceof SettingsError) {
        await ctx.reply(`❌ ${err.message}`);
        return;
      }
      throw err;
    }
  });

  bot.command('tz', async (ctx) => {
    const chat = ctx.chat ? store.getChat(ctx.chat.id) : undefined;
    if (!chat) return;

    const arg = ctx.match.trim();
    if (arg === '') {
      await ctx.reply(`当前时区：${chat.tz}\n修改示例：/tz Asia/Shanghai`);
      return;
    }

    try {
      const tz = validateTimeZone(arg);
      store.setTz(chat.chat_id, tz);
      scheduler.rebuildChat(chat.chat_id);
      const next = scheduler.nextRun(chat.chat_id);
      await ctx.reply(
        [
          `✅ 时区已更新：${tz}`,
          next ? `下次推送：${formatMonthDayTime(next, tz)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (err) {
      if (err instanceof SettingsError) {
        await ctx.reply(`❌ ${err.message}`);
        return;
      }
      throw err;
    }
  });

  bot.command('history', async (ctx) => {
    const chat = ctx.chat ? store.getChat(ctx.chat.id) : undefined;
    if (!chat) return;

    await ctx.reply(formatHistory(store.listSnapshots(10), chat.tz), {
      parse_mode: 'HTML',
    });
  });

  bot.command('status', async (ctx) => {
    const chat = ctx.chat ? store.getChat(ctx.chat.id) : undefined;
    if (!chat) return;

    const last = store.getLatestSnapshot();
    const lastAt = last?.fetchedAt ?? null;
    const next = scheduler.nextRun(chat.chat_id);
    const thresholds = safeThresholds(chat);
    const times = safeTimes(chat, deps);

    const lines = [
      '⚙️ <b>机器人状态</b>',
      '',
      `🆔 chat id：<code>${chat.chat_id}</code>`,
      `🕐 时区：${chat.tz}`,
      chat.push_enabled === 1
        ? `🔔 定时推送：${formatTimes(times)}`
        : '🔕 定时推送：关闭',
      `📌 下次推送：${next ? formatMonthDayTime(next, chat.tz) : '—'}`,
      thresholds.length > 0
        ? `🚦 告警阈值：${thresholds.join('/')}%`
        : '🚦 告警阈值：关闭',
      `📥 最后成功拉取：${formatAge(lastAt)}${
        lastAt ? `（${formatTimestamp(new Date(lastAt), chat.tz)}）` : ''
      }`,
      '🔑 API Key：已配置',
    ];

    if (last) {
      lines.push(
        `📊 窗口状态：${WINDOW_NAMES.map(
          (window) => `${WINDOW_LABELS[window]} ${last.windows[window].status}`,
        ).join(' · ')}`,
      );
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.callbackQuery('refresh', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    const wait = checkManualCooldown(chatId);
    if (wait > 0) {
      await ctx.answerCallbackQuery(`⏳ 请 ${wait} 秒后再试`).catch(() => {});
      return;
    }

    try {
      const snapshot = await coordinator.refresh(true);
      const chat = store.getChat(chatId);
      if (chat) {
        await ctx
          .editMessageText(formatUsageCard(snapshot, cardOptions(chat, deps)), {
            parse_mode: 'HTML',
            reply_markup: keyboard(chat),
          })
          .catch((err) => {
            if (!isNotModifiedError(err)) throw err;
          });
      }
      await ctx.answerCallbackQuery('已刷新').catch(() => {});
    } catch (err) {
      logger.warn({ err: String(err) }, 'callback refresh failed');
      await ctx
        .answerCallbackQuery({ text: '刷新失败，请稍后重试', show_alert: true })
        .catch(() => {});
    }
  });

  bot.callbackQuery('toggle_push', async (ctx) => {
    const chat = ctx.chat ? store.getChat(ctx.chat.id) : undefined;
    if (!chat) return;

    const enabled = chat.push_enabled !== 1;
    store.setPushEnabled(chat.chat_id, enabled);
    scheduler.rebuildChat(chat.chat_id);
    const updated = store.getChat(chat.chat_id) ?? chat;
    const snapshot = store.getLatestSnapshot();

    try {
      if (snapshot) {
        await ctx
          .editMessageText(formatUsageCard(snapshot, cardOptions(updated, deps)), {
            parse_mode: 'HTML',
            reply_markup: keyboard(updated),
          })
          .catch((err) => {
            if (!isNotModifiedError(err)) throw err;
          });
      } else {
        await ctx
          .editMessageReplyMarkup({ reply_markup: keyboard(updated) })
          .catch((err) => {
            if (!isNotModifiedError(err)) throw err;
          });
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'callback toggle failed');
    }

    await ctx
      .answerCallbackQuery(enabled ? '已开启定时推送' : '已关闭定时推送')
      .catch(() => {});
  });

  bot.callbackQuery('history', async (ctx) => {
    const chat = ctx.chat ? store.getChat(ctx.chat.id) : undefined;
    if (!chat) return;

    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(formatHistory(store.listSnapshots(10), chat.tz), {
      parse_mode: 'HTML',
    });
  });
}

export async function setBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'usage', description: '查询当前用量' },
    { command: 'subscribe', description: '开启定时推送' },
    { command: 'unsubscribe', description: '关闭定时推送' },
    { command: 'times', description: '设置推送时间' },
    { command: 'threshold', description: '设置告警阈值' },
    { command: 'tz', description: '设置时区' },
    { command: 'history', description: '查看历史用量' },
    { command: 'status', description: '查看运行状态' },
    { command: 'test', description: '发送测试消息' },
    { command: 'help', description: '查看帮助' },
  ]);
}
