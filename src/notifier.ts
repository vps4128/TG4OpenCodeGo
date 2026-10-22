import { Bot, GrammyError, InlineKeyboard } from 'grammy';
import type { Logger } from './logger.js';
import { errorMessage, redactToken, sleep } from './util.js';

export interface SendOptions {
  reply_markup?: InlineKeyboard;
  disable_notification?: boolean;
}

export type SendResult =
  | { ok: true }
  | { ok: false; blocked: boolean; error: string };

const MAX_TEXT = 4000;

export class Notifier {
  constructor(
    private readonly bot: Bot,
    private readonly logger: Logger,
  ) {}

  async send(chatId: number, text: string, options: SendOptions = {}): Promise<SendResult> {
    const body = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 10)}\n…` : text;
    const extra = {
      parse_mode: 'HTML' as const,
      link_preview_options: { is_disabled: true },
      ...(options.disable_notification ? { disable_notification: true } : {}),
      ...(options.reply_markup ? { reply_markup: options.reply_markup } : {}),
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.bot.api.sendMessage(chatId, body, extra);
        return { ok: true };
      } catch (err) {
        if (err instanceof GrammyError) {
          if (err.error_code === 429) {
            const retryAfter = err.parameters?.retry_after ?? 3;
            this.logger.warn({ chatId, retryAfter }, 'telegram rate limited');
            await sleep(Math.min(retryAfter, 30) * 1000);
            continue;
          }
          if (err.error_code === 403) {
            this.logger.warn({ chatId }, 'telegram chat unavailable');
            return { ok: false, blocked: true, error: '机器人被屏蔽或无权发送消息' };
          }
          return {
            ok: false,
            blocked: false,
            error: `Telegram ${err.error_code}: ${err.description}`,
          };
        }

        const detail = redactToken(errorMessage(err));
        this.logger.warn({ chatId, err: detail }, 'sendMessage failed');
        return { ok: false, blocked: false, error: detail };
      }
    }

    return { ok: false, blocked: false, error: 'Telegram 限流重试失败' };
  }
}
