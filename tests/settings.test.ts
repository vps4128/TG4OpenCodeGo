import { describe, expect, it } from 'vitest';
import {
  parseThresholds,
  parseTimes,
  parseUserIds,
  SettingsError,
  timeToCron,
  validateTimeZone,
} from '../src/settings.js';

describe('parseTimes', () => {
  it('parses, dedupes and sorts times', () => {
    expect(parseTimes('20:00, 09:00, 09:00')).toEqual(['09:00', '20:00']);
  });

  it('rejects empty input', () => {
    expect(() => parseTimes('  ')).toThrow(SettingsError);
  });

  it('rejects malformed times', () => {
    expect(() => parseTimes('9:00')).toThrow(/时间格式不正确/);
    expect(() => parseTimes('24:00')).toThrow(SettingsError);
  });

  it('rejects too many times', () => {
    expect(() => parseTimes('01:00,02:00,03:00,04:00,05:00,06:00,07:00')).toThrow(
      /最多/,
    );
  });
});

describe('parseThresholds', () => {
  it('parses and sorts thresholds', () => {
    expect(parseThresholds('95,50,80,80')).toEqual([50, 80, 95]);
  });

  it('treats off as disabled', () => {
    expect(parseThresholds('off')).toEqual([]);
    expect(parseThresholds('')).toEqual([]);
  });

  it('rejects out-of-range values', () => {
    expect(() => parseThresholds('101')).toThrow(/0-100/);
    expect(() => parseThresholds('-1')).toThrow(SettingsError);
  });
});

describe('validateTimeZone', () => {
  it('accepts IANA zones', () => {
    expect(validateTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai');
  });

  it('rejects unknown zones', () => {
    expect(() => validateTimeZone('Mars/Olympus')).toThrow(SettingsError);
  });
});

describe('parseUserIds', () => {
  it('parses ids', () => {
    expect(parseUserIds('123,456')).toEqual([123, 456]);
  });

  it('rejects non-numeric ids', () => {
    expect(() => parseUserIds('abc')).toThrow(SettingsError);
  });
});

describe('timeToCron', () => {
  it('converts HH:MM to cron', () => {
    expect(timeToCron('09:05')).toBe('5 9 * * *');
    expect(timeToCron('00:00')).toBe('0 0 * * *');
  });
});
