/**
 * Telegram Bot API 请求的超时包装。
 *
 * grammY 的 fetch 默认没有客户端超时。通过代理 / TUN 访问 Telegram 时，
 * 长轮询连接可能被静默丢弃并永久挂起，导致 bot 看起来还在运行、
 * 但再也收不到任何更新。这里为 getUpdates 和其他调用分别设置超时，
 * 让 grammY 的轮询错误处理能够重连。
 *
 * 注意：grammY 传入的 signal 来自 abort-controller 兼容层，
 * 不能直接传给 AbortSignal.any，因此这里手动桥接。
 */
export interface TelegramFetchOptions {
  /** getUpdates 的长轮询超时（毫秒）。应大于 bot.start 的 timeout。 */
  longPollTimeoutMs?: number;
  /** 其他 Bot API 调用的超时（毫秒）。 */
  requestTimeoutMs?: number;
  /** 每次 getUpdates 成功返回后调用，用于写轮询心跳。 */
  onLongPollSuccess?: () => void;
  fetchImpl?: typeof fetch;
}

const DEFAULT_LONG_POLL_TIMEOUT = 45_000;
const DEFAULT_REQUEST_TIMEOUT = 15_000;

export function createTelegramFetch(options: TelegramFetchOptions = {}): typeof fetch {
  const baseFetch = options.fetchImpl ?? fetch;
  const longPollTimeout = options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT;
  const requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;

  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const isLongPoll = url.includes('/getUpdates');
    const timeoutMs = isLongPoll ? longPollTimeout : requestTimeout;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    const callerSignal = init?.signal ?? undefined;
    const onAbort = (): void => controller.abort();

    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', onAbort);
    }

    try {
      const response = await baseFetch(input, { ...init, signal: controller.signal });
      if (isLongPoll && response.ok) {
        try {
          options.onLongPollSuccess?.();
        } catch {
          // 心跳写入失败不应影响轮询
        }
      }
      return response;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    }
  };
}
