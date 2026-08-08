import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)
dayjs.extend(timezone)

export interface SimpleDuration {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}
export interface SimpleDateTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}
export type DayjsLike = string | number | Dayjs | Date | null | undefined
export type DateLike = DayjsLike
export type Durationlike = [DateLike, DateLike] | number
export interface DurationFormatOptions {
  expand?: boolean
  just_now?: string
}

const DAYS_IN_A_YEAR = 365.2425
const DAYS_IN_A_MONTH = DAYS_IN_A_YEAR / 12

const YEAR_MS = 1000 * 60 * 60 * 24 * DAYS_IN_A_YEAR
const MONTH_MS = 1000 * 60 * 60 * 24 * DAYS_IN_A_MONTH
const DAY_MS = 1000 * 60 * 60 * 24
const HOUR_MS = 1000 * 60 * 60
const MINUTE_MS = 1000 * 60
const SECOND_MS = 1000

// The display timezone is app-wide client state. It is synced from the
// timezone cookie by the timezone plugin (which always has a Nuxt context),
// so these pure utilities never need access to the Nuxt instance themselves
// and can be called from any context (timers, MQTT callbacks, etc.).
let display_timezone = 'UTC'

export function get_display_timezone() {
  return display_timezone
}

export function set_display_timezone(tz: string | null | undefined) {
  display_timezone = tz || 'UTC'
}

export function localize_date(input?: DateLike, keep_local?: boolean) {
  const tz = get_display_timezone()
  if (input === null || input === undefined) {
    return dayjs().tz(tz, keep_local ?? false)
  }
  if (typeof input === 'string' || typeof input === 'number') {
    return dayjs.utc(input).tz(tz, keep_local ?? false)
  }
  return dayjs(input).tz(tz, keep_local ?? false)
}

export function duration_between(start_date: DateLike, end_date: DateLike) {
  let start = localize_date(start_date)
  let end = localize_date(end_date)

  if (start.isAfter(end)) {
    [start, end] = [end, start]
  }

  return {
    year: end.diff(start, 'year'),
    month: end.diff(start, 'month') % 12,
    day: end.diff(start, 'day') % 30,
    hour: end.diff(start, 'hour') % 24,
    minute: end.diff(start, 'minute') % 60,
    second: end.diff(start, 'second') % 60,
  }
}

export function duration_read(duration: Durationlike) {
  if (typeof duration === 'number') {
    let remaining = Math.abs(duration)
    const year = Math.floor(remaining / YEAR_MS)
    remaining -= year * YEAR_MS
    const month = Math.floor(remaining / MONTH_MS)
    remaining -= month * MONTH_MS
    const day = Math.floor(remaining / DAY_MS)
    remaining -= day * DAY_MS
    const hour = Math.floor(remaining / HOUR_MS)
    remaining -= hour * HOUR_MS
    const minute = Math.floor(remaining / MINUTE_MS)
    remaining -= minute * MINUTE_MS
    const second = Math.floor(remaining / SECOND_MS)
    return {
      year,
      month,
      day,
      hour,
      minute,
      second,
    }
  }

  const [start, end] = duration
  return duration_between(start, end)
}

export function duration_build_string(duration: Durationlike, template: string | [string, string], options: DurationFormatOptions = {}) {
  const {
    year,
    month,
    day,
    hour,
    minute,
    second,
  } = duration_read(duration)
  const just_now = options.just_now ?? ''
  const formated = duration_format(duration, { expand: false, just_now })
  const formated_expand = duration_format(duration, { expand: true })
  const replacements: Record<string, string> = {
    '{Y}': `${year}`,
    '{M}': `${month}`,
    '{D}': `${day}`,
    '{h}': `${hour}`,
    '{i}': `${minute}`,
    '{s}': `${second}`,
    '{formated}': formated,
    '{formated_expand}': formated_expand,
  }
  const regex = new RegExp(Object.keys(replacements).join('|'), 'g')

  if (Array.isArray(template)) {
    return (formated === just_now ? template[1] : template[0]).replace(regex, match => replacements[match]!)
  }
  return template.replace(regex, match => replacements[match]!)
}

export function duration_format(duration: Durationlike, options: DurationFormatOptions = {}) {
  const {
    year,
    month,
    day,
    hour,
    minute,
    second,
  } = duration_read(duration)
  if (options.expand) {
    const parts = [
      year ? ` ${year} 年` : '',
      month ? ` ${month} 个月` : '',
      day ? ` ${day} 天` : '',
      hour ? ` ${hour} 小时` : '',
      minute ? ` ${minute} 分` : '',
      second ? ` ${(`${second}`).padStart(2, '0')} 秒` : '',
    ]
    return parts.filter(Boolean).toSpliced(2)
      .join('')
      .replace(/^ 0/, ' ')
      .replace(/分$/, '分钟') || ' 0 秒'
  }
  else {
    const parts = [
      year ? ` ${year} 年` : '',
      month ? ` ${month} 个月` : '',
      day ? ` ${day} 天` : '',
      hour ? ` ${hour} 小时` : '',
      minute ? ` ${minute} 分钟` : '',
    ]
    return parts.filter(Boolean)[0] || (options.just_now ?? ` ${second} 秒`)
  }
}

export function datetime_read(date: DateLike) {
  const d = localize_date(date)
  return {
    year: d.year(),
    month: d.month() + 1,
    day: d.date(),
    hour: d.hour(),
    minute: d.minute(),
    second: d.second(),
  }
}

export function datetime_build_string(date: DateLike, template: string) {
  const { year, month, day, hour, minute, second } = datetime_read(date)
  const hour_12 = hour % 12 || 12
  const replacements: Record<string, string> = {
    '{YYYY}': `${year}`,
    '{MM}': `${month}`.padStart(2, '0'),
    '{DD}': `${day}`.padStart(2, '0'),
    '{HH}': `${hour}`.padStart(2, '0'),
    '{hh}': `${hour_12}`.padStart(2, '0'),
    '{mm}': `${minute}`.padStart(2, '0'),
    '{ss}': `${second}`.padStart(2, '0'),
    '{YY}': `${(`${year}`).slice(- 2)}`,
    '{M}': `${month}`,
    '{D}': `${day}`,
    '{H}': `${hour}`,
    '{h}': `${hour_12}`,
    '{m}': `${minute}`,
    '{s}': `${second}`,
  }
  const regex = new RegExp(Object.keys(replacements).join('|'), 'g')

  return template.replace(regex, match => replacements[match]!)
}

export function date_format(date: DateLike) {
  return datetime_build_string(date, '{YYYY}/{M}/{D}')
}

export function time_format(date: DateLike) {
  return datetime_build_string(date, '{HH}:{mm}:{ss}')
}

export function datetime_format(date: DateLike) {
  return datetime_build_string(date, '{YYYY}/{M}/{D} {HH}:{mm}:{ss}')
}
