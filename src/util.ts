export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 避免 Telegram Bot Token 出现在日志中。 */
export function redactToken(text: string): string {
  return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>');
}
