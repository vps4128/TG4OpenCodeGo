import pino from 'pino';

export type Logger = ReturnType<typeof pino>;

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { app: 'tg4opencodego' },
    redact: {
      paths: ['apiKey', 'token', 'authorization', 'headers.authorization', '*.apiKey', '*.token'],
      censor: '[redacted]',
    },
  });
}
