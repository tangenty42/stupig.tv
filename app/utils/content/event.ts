import type { ContentEventPrecision } from '@shared/types/content'
import { datetime_build_string } from '~/utils/time'

function format_event_entry(precision: ContentEventPrecision, date: string) {
  if (precision === 'month')
    return datetime_build_string(date, '{YY} 年 {M} 月')
  return datetime_build_string(date, '{YY} 年 {M} 月 {D} 日')
}

/** Single date or `start ~ end` range as plain text; accepts event_dates or meta event_entries. */
export function format_event_range(precision: ContentEventPrecision, dates: string[]) {
  const first = dates[0]
  const last = dates[dates.length - 1]
  if (! first || ! last || first === last)
    return first ? format_event_entry(precision, first) : ''
  return `${format_event_entry(precision, first)} ~ ${format_event_entry(precision, last)}`
}
