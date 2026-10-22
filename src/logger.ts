import pino from 'pino';

export type Logger = ReturnType<typeof pino>;

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { app: 'oc-tg' },
    redact: {
      paths: ['apiKey', 'token', 'authorization', 'headers.authorization', '*.apiKey', '*.token'],
      censor: '[redacted]',
    },
  });
}
