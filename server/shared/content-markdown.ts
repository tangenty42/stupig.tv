// 蠢猪档案 story markdown notation.
// The markdown document is the single source of truth: title, rating and event
// time live in a small front matter block at the very top of the document:
//
//   ---
//   title: 蠢猪大闹食堂
//   rating: 4
//   time: 2026/3/14 ~ 2026/3/16
//   ---
//
// `time` accepts one day (YYYY/M/D), one month (YYYY/M), or an inclusive range
// joined by `~`. Month/day zero-padding is optional, but range endpoints must
// have the same precision. This parser is a strict subset parser (no YAML
// dependency) and runs on both client (live lint) and server.

export type ContentEventPrecision = 'day' | 'month'

export interface ContentStoryMeta {
  title: string
  rating: number
  event_precision: ContentEventPrecision
  /** 'YYYY-MM-DD' entries for day precision, 'YYYY-MM' entries for month precision. */
  event_entries: string[]
}
export interface ContentLintIssue {
  /** 1-based line number. */
  line: number
  message: string
}

export interface StoryMarkdownParseResult {
  meta: ContentStoryMeta | null
  issues: ContentLintIssue[]
}

export interface ContentMarkdownConfig {
  title_max_length: number
  rating_min: number
  rating_max: number
}

const fm_key_line = /^([A-Z_]\w*)\s*:(.*)$/i
const day_entry = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/
const month_entry = /^(\d{4})\/(\d{1,2})$/

function is_real_date(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function push_issue(issues: ContentLintIssue[], line: number, message: string) {
  issues.push({ line, message })
}

function padded_number(value: number) {
  return String(value).padStart(2, '0')
}

function day_string(year: number, month: number, day: number) {
  return `${year}-${padded_number(month)}-${padded_number(day)}`
}

function month_string(year: number, month: number) {
  return `${year}-${padded_number(month)}`
}

function expand_day_range(start: string, end: string) {
  const [year, month, day] = start.split('-').map(Number) as [number, number, number]
  const cursor = new Date(0)
  cursor.setUTCHours(0, 0, 0, 0)
  cursor.setUTCFullYear(year, month - 1, day)

  const entries: string[] = []
  while (true) {
    const entry = day_string(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate())
    if (entry > end) {
      break
    }
    entries.push(entry)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return entries
}

function expand_month_range(start: string, end: string) {
  const [start_year, start_month] = start.split('-').map(Number) as [number, number]
  const [end_year, end_month] = end.split('-').map(Number) as [number, number]
  const end_index = end_year * 12 + end_month - 1
  const entries: string[] = []

  for (let index = start_year * 12 + start_month - 1; index <= end_index; index ++) {
    entries.push(month_string(Math.floor(index / 12), index % 12 + 1))
  }
  return entries
}

/** Parse and validate the front matter of a story markdown document. */
export function parse_story_markdown(markdown: string, config: ContentMarkdownConfig) {
  const issues: ContentLintIssue[] = []
  const lines = markdown.split('\n')

  if (lines[0]?.trim() !== '---') {
    push_issue(issues, 1, '文件开头必须是 Front Matter（--- 包裹的元信息块，包含 title / rating / time）')
    return { meta: null, issues }
  }

  let end_line = - 1
  for (let i = 1; i < lines.length; i ++) {
    if (lines[i]?.trim() === '---') {
      end_line = i
      break
    }
  }
  if (end_line === - 1) {
    push_issue(issues, 1, 'Front Matter 缺少结束的 --- 行')
    return { meta: null, issues }
  }

  let title: string | null = null
  let rating: number | null = null
  let event_precision: ContentEventPrecision | null = null
  let event_entries: string[] = []
  const seen_keys = new Set<string>()

  for (let i = 1; i < end_line; i ++) {
    const raw = lines[i] ?? ''
    const line_no = i + 1
    if (! raw.trim()) {
      continue
    }

    const match = fm_key_line.exec(raw)
    if (! match) {
      push_issue(issues, line_no, '无法解析的行，格式应为 `key: value`')
      continue
    }

    const key = match[1]!
    const value = (match[2] ?? '').trim()

    if (seen_keys.has(key)) {
      push_issue(issues, line_no, `重复的字段 \`${key}\``)
      continue
    }
    seen_keys.add(key)

    switch (key) {
      case 'title': {
        if (! value) {
          push_issue(issues, line_no, '标题不能为空')
        }
        else if ([... value].length > config.title_max_length) {
          push_issue(issues, line_no, `标题太长了，最多 ${config.title_max_length} 个字符`)
        }
        else {
          title = value
        }
        break
      }
      case 'rating': {
        const parsed = Number(value)
        if (! Number.isInteger(parsed) || parsed < config.rating_min || parsed > config.rating_max) {
          push_issue(issues, line_no, `评分必须是 ${config.rating_min}~${config.rating_max} 的整数`)
        }
        else {
          rating = parsed
        }
        break
      }
      case 'time': {
        const tokens = value.split('~').map(token => token.trim())
        if (! value || tokens.some(token => ! token) || tokens.length > 2) {
          push_issue(issues, line_no, '时间格式应为 年/月/日、年/月，或用 ~ 连接起止时间')
          break
        }

        let kind: ContentEventPrecision | null = null
        const entries: string[] = []
        let failed = false

        for (const token of tokens) {
          const day_match = day_entry.exec(token)
          const month_match = month_entry.exec(token)

          if (day_match) {
            if (kind === 'month') {
              push_issue(issues, line_no, '时间不能混用「某天」和「某月」两种格式')
              failed = true
              break
            }
            kind = 'day'
            const [, y, m, d] = day_match
            const year = Number(y)
            const month = Number(m)
            const day = Number(d)
            if (! is_real_date(year, month, day)) {
              push_issue(issues, line_no, `不存在的日期：${token}`)
              failed = true
              break
            }
            entries.push(day_string(year, month, day))
          }
          else if (month_match) {
            if (kind === 'day') {
              push_issue(issues, line_no, '时间不能混用「某天」和「某月」两种格式')
              failed = true
              break
            }
            kind = 'month'
            const [, y, m] = month_match
            const year = Number(y)
            const month = Number(m)
            if (month < 1 || month > 12) {
              push_issue(issues, line_no, `不存在的月份：${token}`)
              failed = true
              break
            }
            entries.push(month_string(year, month))
          }
          else {
            push_issue(issues, line_no, `无法识别的时间：${token}（应为 年/月/日 或 年/月）`)
            failed = true
            break
          }
        }

        if (! failed && kind) {
          if (entries.length === 2 && entries[0]! > entries[1]!) {
            push_issue(issues, line_no, '起始时间不能晚于结束时间')
          }
          else {
            event_precision = kind
            event_entries = entries.length === 1
              ? entries
              : kind === 'day'
                ? expand_day_range(entries[0]!, entries[1]!)
                : expand_month_range(entries[0]!, entries[1]!)
          }
        }
        break
      }
      default:
        push_issue(issues, line_no, `不支持的字段 \`${key}\`，只允许 title / rating / time`)
    }
  }

  if (! seen_keys.has('title')) {
    push_issue(issues, 1, 'Front Matter 缺少 title 字段')
  }
  if (rating === null && ! seen_keys.has('rating')) {
    push_issue(issues, 1, 'Front Matter 缺少 rating 字段')
  }
  if (! seen_keys.has('time')) {
    push_issue(issues, 1, 'Front Matter 缺少 time 字段')
  }

  if (issues.length || title === null || rating === null || ! event_precision || ! event_entries.length) {
    return { meta: null, issues }
  }

  return {
    meta: { title, rating, event_precision, event_entries },
    issues,
  }
}

/** Skeleton inserted into the editor when creating a new story. */
export function story_markdown_template(config: ContentMarkdownConfig) {
  const [year, month, day] = new Date().toISOString().slice(0, 10).split('-').map(Number)
  const default_rating = Math.round((config.rating_min + config.rating_max) / 2)
  return [
    '---',
    'title: ',
    `rating: ${default_rating}`,
    `time: ${year}/${month}/${day}`,
    '---',
    '',
  ].join('\n')
}

/** Remove the front matter block, leaving only the markdown body. */
export function strip_front_matter(markdown: string) {
  const lines = markdown.split('\n')
  if (lines[0]?.trim() !== '---') {
    return markdown
  }
  for (let i = 1; i < lines.length; i ++) {
    if (lines[i]?.trim() === '---') {
      return lines.slice(i + 1).join('\n')
    }
  }
  return markdown
}

/** Root-relative URL path for an attachment (the static host prefixes it at render time). */
export function attachment_url_path(story_id: number, file_name: string) {
  return `/content/${story_id}/${encodeURIComponent(file_name)}`
}

/** Story-local URL used inside Markdown attachment links. */
export function attachment_markdown_path(file_name: string) {
  return encodeURIComponent(file_name)
}

const markdown_link = /(!?\[[^\]]*\]\(\s*<?)([^)\s<>]+)(>?(?:\s+"[^"]*")?\s*\))/g

function attachment_name_from_url(url: string) {
  if (url.includes('/') || url.startsWith('#') || /^[a-z][\w+.-]*:/i.test(url)) {
    return null
  }

  if (! url) {
    return null
  }
  try {
    const decoded = decodeURIComponent(url)
    return decoded.includes('/') ? null : decoded
  }
  catch {
    return url
  }
}

/** Extract attachment file names referenced from the markdown body for a story. */
export function extract_attachment_names(markdown: string) {
  const names = new Set<string>()

  for (const match of markdown.matchAll(markdown_link)) {
    const url = match[2] ?? ''
    const name = attachment_name_from_url(url)
    if (name) {
      names.add(name)
    }
  }

  return [... names]
}

/** Rename matching attachment URLs and default link labels without touching custom labels. */
export function rename_attachment_references(markdown: string, old_file_name: string, new_file_name: string) {
  const new_local_path = attachment_markdown_path(new_file_name)

  return markdown.replace(markdown_link, (link, prefix: string, url: string, suffix: string) => {
    if (attachment_name_from_url(url) !== old_file_name) {
      return link
    }

    const renamed_link = `${prefix}${new_local_path}${suffix}`
    return renamed_link.replace(/^(!?)\[([^\]]*)\]/, (label, marker: string, text: string) => {
      return text === old_file_name ? `${marker}[${new_file_name}]` : label
    })
  })
}
