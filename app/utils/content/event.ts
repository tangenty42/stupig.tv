import type { ContentEventPrecision } from '@shared/types/content'
import type { DateLike } from '~/utils/time'
import { datetime_build_string, datetime_read } from '~/utils/time'

/** Single date as plain text, e.g. `2025 年 9 月` or `2025 年 9 月 22 日`. */
export function format_event_entry(precision: ContentEventPrecision, date: DateLike) {
  if (precision === 'month')
    return datetime_build_string(date, '{YYYY} 年 {M} 月')
  return datetime_build_string(date, '{YYYY} 年 {M} 月 {D} 日')
}

/** Single date or range as plain text; collapses the shared year/month prefix, e.g. `2026 年 8 月 3~23 日`. */
export function format_event_range(precision: ContentEventPrecision, dates: string[]) {
  const first = dates[0]
  const last = dates[dates.length - 1]
  if (! first || ! last || first === last)
    return first ? format_event_entry(precision, first) : ''
  const start = datetime_read(first)
  const end = datetime_read(last)
  if (start.year !== end.year)
    return `${format_event_entry(precision, first)} ~ ${format_event_entry(precision, last)}`
  if (precision === 'month') {
    if (start.month === end.month)
      return format_event_entry(precision, first)
    return `${start.year} 年 ${start.month}~${end.month} 月`
  }
  if (start.month === end.month) {
    if (start.day === end.day)
      return format_event_entry(precision, first)
    return `${start.year} 年 ${start.month} 月 ${start.day}~${end.day} 日`
  }
  return `${start.year} 年 ${start.month} 月 ${start.day} 日 ~ ${end.month} 月 ${end.day} 日`
}
