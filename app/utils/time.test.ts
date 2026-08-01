import dayjs from 'dayjs'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'
import { describe, expect, it } from 'vitest'
import {
  date_format,
  datetime_build_string,
  datetime_format,
  datetime_read,
  duration_build_string,
  duration_format,
  duration_read,
  set_display_timezone,
  time_format,
} from './time'

dayjs.extend(utc)
dayjs.extend(timezone)

// time.ts resolves the display timezone from module state that is normally
// synced from the timezone cookie by the timezone Nuxt plugin. Pin it to a
// fixed non-system zone so the tests genuinely assert cookie-driven
// localization rather than system-local time.
const MOCK_TIMEZONE = 'Atlantic/Cape_Verde'
set_display_timezone(MOCK_TIMEZONE)

// Expected wall-clock components produced by localize_date(). It parses the
// input as UTC then applies .tz(tz), converting to the mocked cookie zone.
function expected_parts(input: string | number | Date) {
  const d = dayjs.utc(input).tz(MOCK_TIMEZONE)
  return {
    year: d.year(),
    month: d.month() + 1,
    day: d.date(),
    hour: d.hour(),
    minute: d.minute(),
    second: d.second(),
  }
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

describe('duration_read', () => {
  it('converts a positive millisecond number into a SimpleDuration', () => {
    const result = duration_read(3_661_001_000)
    expect(result.year).toBe(0)
    expect(result.month).toBe(1)
    expect(result.day).toBe(11)
    expect(result.hour).toBe(22)
    expect(result.minute).toBe(27)
    expect(result.second).toBe(35)
  })

  it('converts a negative millisecond number using absolute value', () => {
    const result = duration_read(- 60_000)
    expect(result.minute).toBe(1)
    expect(result.second).toBe(0)
  })

  it('returns zero duration for 0 ms', () => {
    const result = duration_read(0)
    expect(result).toMatchObject({
      year: 0,
      month: 0,
      day: 0,
      hour: 0,
      minute: 0,
      second: 0,
    })
  })

  it('computes duration from a tuple of UTC timestamps', () => {
    const result = duration_read(['2024-01-01T00:00:00Z', '2024-01-01T00:00:01Z'])
    expect(result.second).toBe(1)
  })

  it('computes duration from a tuple of epoch millisecond numbers', () => {
    const start = new Date('2024-01-01T00:00:00Z').getTime()
    const end = new Date('2024-01-01T00:00:01Z').getTime()
    const result = duration_read([start, end])
    expect(result.second).toBe(1)
  })

  it('computes duration from a tuple of Date objects', () => {
    const d1 = new Date('2024-01-01T00:00:00Z')
    const d2 = new Date('2024-01-01T00:00:01Z')
    const result = duration_read([d1, d2])
    expect(result.second).toBe(1)
  })

  it('swaps tuple elements when start is after end', () => {
    const result = duration_read(['2024-01-01T00:00:01Z', '2024-01-01T00:00:00Z'])
    expect(result.second).toBe(1)
  })
})

describe('duration_format', () => {
  it('renders compact fallback for sub-minute durations', () => {
    expect(duration_format(45_000, { expand: false })).toBe(' 45 秒')
  })

  it('renders compact minute duration', () => {
    expect(duration_format(60_000, { expand: false })).toBe(' 1 分钟')
  })

  it('renders compact hour duration', () => {
    expect(duration_format(3_600_000, { expand: false })).toBe(' 1 小时')
  })

  it('renders compact day duration', () => {
    expect(duration_format(86_400_000, { expand: false })).toBe(' 1 天')
  })

  it('renders expanded duration with minute and seconds', () => {
    const result = duration_format(1 * 60 * 1000 + 5 * 1000, { expand: true })
    expect(result).toBe(' 1 分 05 秒')
  })

  it('renders expanded duration with only seconds', () => {
    const result = duration_format(5_000, { expand: true })
    expect(result).toBe(' 5 秒')
  })

  it('renders expanded duration for zero seconds', () => {
    const result = duration_format(0, { expand: true })
    expect(result).toBe(' 0 秒')
  })

  it('supports custom just-now text', () => {
    expect(duration_format(1_000, { expand: false, just_now: 'just now' })).toBe('just now')
  })

  it('uses precise seconds when just-now text is omitted', () => {
    expect(duration_format(1_000, { expand: false })).toBe(' 1 秒')
  })
})

describe('duration_build_string', () => {
  it('replaces duration tokens in a template', () => {
    const result = duration_build_string(3_661_001_000, '{Y}|{M}|{D}|{h}|{i}|{s}')
    expect(result).toBe('0|1|11|22|27|35')
  })

  it('replaces the compact formatted duration token', () => {
    const result = duration_build_string(1_201_000, '{formated}')
    expect(result).toBe(' 20 分钟')
  })

  it('replaces the expanded formatted duration token', () => {
    const result = duration_build_string(1_201_000, '{formated_expand}')
    expect(result).toBe(' 20 分 01 秒')
  })

  it('selects the normal template variant for non-just-now durations', () => {
    const result = duration_build_string(3_600_000, ['{formated}', '刚刚'], { just_now: '刚刚' })
    expect(result).toBe(' 1 小时')
  })

  it('selects the just-now template variant when the duration formats to just_now', () => {
    const result = duration_build_string(1_000, ['{formated}前', '刚刚'], { just_now: '刚刚' })
    expect(result).toBe('刚刚')
  })

  it('replaces tokens inside the just-now template variant', () => {
    const result = duration_build_string(30_000, ['{formated}前', '就在{formated}'], { just_now: '刚刚' })
    expect(result).toBe('就在刚刚')
  })
})

describe('datetime_read', () => {
  it('reads a UTC ISO string as cookie-zone local time', () => {
    const result = datetime_read('2024-05-15T14:30:45Z')
    expect(result).toEqual(expected_parts('2024-05-15T14:30:45Z'))
  })

  it('reads an epoch millisecond number as cookie-zone local time', () => {
    const ts = new Date('2024-05-15T14:30:45Z').getTime()
    const result = datetime_read(ts)
    expect(result).toEqual(expected_parts(ts))
  })

  it('reads a local Date object as cookie-zone local time', () => {
    const date = new Date(2024, 4, 15, 14, 30, 45)
    const result = datetime_read(date)
    expect(result).toEqual(expected_parts(date))
  })

  it('reads undefined as current local time', () => {
    const result = datetime_read(undefined)
    expect(result.year).toBeGreaterThan(2000)
    expect(result.month).toBeGreaterThan(0)
  })
})

describe('datetime_build_string', () => {
  it('formats a UTC ISO string using cookie-zone local components', () => {
    const p = expected_parts('2024-01-15T09:05:03Z')
    const expected = `${p.year}/${pad(p.month)}/${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
    const result = datetime_build_string('2024-01-15T09:05:03Z', '{YYYY}/{MM}/{DD} {HH}:{mm}:{ss}')
    expect(result).toBe(expected)
  })

  it('formats a UTC epoch number using cookie-zone local components', () => {
    const ts = new Date('2024-01-15T09:05:03Z').getTime()
    const p = expected_parts(ts)
    const expected = `${p.year}/${pad(p.month)}/${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
    const result = datetime_build_string(ts, '{YYYY}/{MM}/{DD} {HH}:{mm}:{ss}')
    expect(result).toBe(expected)
  })

  it('formats a local Date object using cookie-zone local components', () => {
    const date = new Date(2024, 0, 15, 9, 5, 3)
    const p = expected_parts(date)
    const expected = `${p.year}/${pad(p.month)}/${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
    const result = datetime_build_string(date, '{YYYY}/{MM}/{DD} {HH}:{mm}:{ss}')
    expect(result).toBe(expected)
  })

  it('uses single-digit tokens without padding', () => {
    const p = expected_parts('2024-01-01T00:00:00Z')
    const expected = `${p.year.toString().slice(- 2)}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
    const result = datetime_build_string('2024-01-01T00:00:00Z', '{YY}-{M}-{D} {H}:{m}:{s}')
    expect(result).toBe(expected)
  })

  it('formats a two-digit year with {YY} based on current century cutoff', () => {
    const result_1996 = datetime_build_string('1996-01-01T00:00:00Z', '{YY}-{M}-{D}')
    const p_1996 = expected_parts('1996-01-01T00:00:00Z')
    expect(result_1996).toBe(`${p_1996.year.toString().slice(- 2)}-${p_1996.month}-${p_1996.day}`)

    const result_2026 = datetime_build_string('2026-01-01T00:00:00Z', '{YY}-{M}-{D}')
    const p_2026 = expected_parts('2026-01-01T00:00:00Z')
    expect(result_2026).toBe(`${p_2026.year.toString().slice(- 2)}-${p_2026.month}-${p_2026.day}`)

    const result_2006 = datetime_build_string('2006-01-01T00:00:00Z', '{YY}-{M}-{D}')
    const p_2006 = expected_parts('2006-01-01T00:00:00Z')
    expect(result_2006).toBe(`${p_2006.year.toString().slice(- 2)}-${p_2006.month}-${p_2006.day}`)
  })

  it('formats padded and unpadded 12-hour clock tokens', () => {
    expect(datetime_build_string('2024-01-01T01:00:00Z', '{hh}|{h}')).toBe('12|12')
    expect(datetime_build_string('2024-01-01T13:00:00Z', '{hh}|{h}')).toBe('12|12')
    expect(datetime_build_string('2024-01-01T16:00:00Z', '{hh}|{h}')).toBe('03|3')
  })
})

describe('convenience formatters', () => {
  it('date_format produces a date-only string from a UTC string in local time', () => {
    const result = date_format('2024-01-15T09:05:03Z')
    expect(result).toBe('2024/1/15')
  })

  it('time_format produces a time-only string from a UTC string in cookie-zone local time', () => {
    const p = expected_parts('2024-01-15T09:05:03Z')
    const expected = `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
    const result = time_format('2024-01-15T09:05:03Z')
    expect(result).toBe(expected)
  })

  it('datetime_format produces a full datetime string from a UTC string in cookie-zone local time', () => {
    const p = expected_parts('2024-01-15T09:05:03Z')
    const expected = `${p.year}/${p.month}/${p.day} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
    const result = datetime_format('2024-01-15T09:05:03Z')
    expect(result).toBe(expected)
  })
})
