// 蠢猪档案 story markdown notation.
// The markdown document is the single source of truth: title, labels and event
// time live in a small front matter block at the very top of the document:
//
//   ---
//   title: 蠢猪大闹食堂
//   label: #人上人 食堂 爆笑
//   time: 2026/3/14 ~ 2026/3/16
//   ---
//
// `label` is optional and holds space-separated tags; a tag starting with '#'
// is hidden (never shown as a regular label): either a rating tier or the
// '#置顶' pin tag that keeps the story at the top of the list. `time` accepts one
// day (YYYY/M/D), one month (YYYY/M), or an inclusive range joined by `~`.
// `desc` is an optional plain-text description shown under the title; `cover` is
// an optional single cover image shown under the desc, written as markdown image
// syntax `![](file.jpg)` or a bare URL/file name. Month/day zero-padding
// is optional, but range endpoints must have the same precision. This parser
// is a strict subset parser (no YAML dependency) and runs on both client
// (live lint) and server.

export type ContentEventPrecision = 'day' | 'month'

/** Rating tiers from lowest to highest; stored as `#`-prefixed labels. */
export const content_rating_tiers = ['拉完了', 'NPC', '人上人', '顶级', '夯'] as const
export type ContentRatingTier = typeof content_rating_tiers[number]
export const unrated_content_rating = '难评' as const
export type ContentRating = ContentRatingTier | typeof unrated_content_rating
export type ContentRatingInput = ContentRatingTier | string | string[] | null

/** The front matter label that encodes a rating tier, e.g. '#夯'. */
export function rating_label(tier: ContentRatingTier) {
  return `#${tier}`
}

/** Hidden `#`-label that keeps a story at the top of the list. */
export const pinned_label = '#置顶'

/** Whether the labels array carries the `#置顶` pin tag. */
export function story_pinned(labels: string[]) {
  return labels.includes(pinned_label)
}

/** Resolve a tier name, rating label, or labels array; returns `难评` when unrated. */
export function story_rating(value: ContentRatingInput): ContentRating {
  if (Array.isArray(value)) {
    // Scan from the end so the LAST rating # label wins when several are
    // present (earlier ones are ignored).
    for (let index = value.length - 1; index >= 0; index --) {
      const label = value[index]!
      if (! label.startsWith('#'))
        continue
      const tier = content_rating_tiers.find(item => item === label.slice(1))
      if (tier)
        return tier
    }
    return unrated_content_rating
  }
  const tier = value?.startsWith('#') ? value.slice(1) : value
  return content_rating_tiers.find(item => item === tier) ?? unrated_content_rating
}

/** Rank for sorting (0 when unrated); higher is better. */
export function story_rating_rank(value: ContentRatingInput) {
  const tier = story_rating(value)
  return tier === unrated_content_rating ? 0 : content_rating_tiers.indexOf(tier) + 1
}

export interface ContentStoryMeta {
  title: string
  labels: string[]
  event_precision: ContentEventPrecision
  /** 'YYYY-MM-DD' entries for day precision, 'YYYY-MM' entries for month precision. */
  event_entries: string[]
  /** Optional plain-text description shown under the title. */
  desc: string | null
  /** Optional single cover image link (attachment file name or external URL) shown under the desc. */
  cover: string | null
  /** Optional cover image alt text (`![label](file.jpg)`); null when written as a bare link. */
  cover_label: string | null
}
export interface ContentLintIssue {
  /** 1-based line number. */
  line: number
  severity: 'error' | 'warning'
  source: string
  message: string
}

export interface StoryMarkdownParseResult {
  meta: ContentStoryMeta | null
  issues: ContentLintIssue[]
}

export interface ContentMarkdownConfig {
  /** Title limit in UTF-8 bytes (the column is varchar(120), so bytes are the binding constraint). */
  title_max_length: number
  /** Whole `label` line limit in UTF-8 bytes. */
  label_max_bytes: number
  desc_max_bytes: number
  cover_max_bytes: number
  /** Whole document limit in UTF-8 bytes; the column is mediumtext. */
  markdown_max_bytes: number
  /** Existing story titles (id + title) for duplicate-title linting; `current_story_id` excludes the story being edited. */
  existing_titles?: { id: number, title: string }[]
}

const fm_key_line = /^([A-Z_]\w*)\s*:(.*)$/i
const day_entry = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/
const month_entry = /^(\d{4})\/(\d{1,2})$/

function is_real_date(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
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

/** Characters not allowed in attachment file names; matches the rename schema's rejected set. */
// eslint-disable-next-line no-control-regex -- control chars are exactly what we must reject
export const link_file_name_illegal_chars = /[<>:"?*|()[\]\\/\s#@&=%`\x00-\x1F\x7F]/g

/** True when `value` contains any attachment-illegal character (resets the shared regex's `lastIndex`). */
function has_attachment_illegal_char(value: string) {
  link_file_name_illegal_chars.lastIndex = 0
  return link_file_name_illegal_chars.test(value)
}

/** Parse and validate the front matter of a story markdown document. */
export function parse_story_markdown(markdown: string, config: ContentMarkdownConfig) {
  const issues: ContentLintIssue[] = []
  const lines = markdown.split('\n')

  if (link_file_name_byte_length(markdown) > config.markdown_max_bytes) {
    issues.push({ line: 1, severity: 'error', source: 'document', message: `内容太长了，最多 ${config.markdown_max_bytes} 字节` })
  }

  let end_line = - 1
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i ++) {
      if (lines[i]?.trim() === '---') {
        end_line = i
        break
      }
    }
  }

  const front_matter_ok = lines[0]?.trim() === '---' && end_line !== - 1
  if (lines[0]?.trim() !== '---') {
    issues.push({ line: 1, severity: 'error', source: 'front-matter', message: '文件开头必须是 Front Matter（--- 包裹的元信息块，包含 title / label / time / desc / cover）' })
  }
  else if (end_line === - 1) {
    issues.push({ line: 1, severity: 'error', source: 'front-matter', message: 'Front Matter 缺少结束的 --- 行' })
  }

  let title: string | null = null
  let labels: string[] = []
  let event_precision: ContentEventPrecision | null = null
  let event_entries: string[] = []
  let desc: string | null = null
  let cover: string | null = null
  let cover_label: string | null = null
  const seen_keys = new Set<string>()

  // First body line (0-based index); broken front matter turns every line
  // after the first into body. The body is linted after this loop, once
  // `title` is known.
  const body_start = front_matter_ok ? end_line + 1 : 1

  for (let i = 1; i < lines.length; i ++) {
    const raw = lines[i] ?? ''
    const line_no = i + 1

    if (i >= body_start) {
      break
    }
    if (i === end_line || ! raw.trim()) {
      continue
    }

    const match = fm_key_line.exec(raw)
    if (! match) {
      issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: '无法解析的行，格式应为 `key: value`' })
      continue
    }

    const key = match[1]!
    const value = (match[2] ?? '').trim()

    if (seen_keys.has(key)) {
      issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: `重复的字段 \`${key}\`` })
      continue
    }
    seen_keys.add(key)

    switch (key) {
      case 'title': {
        if (! value) {
          issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: '标题不能为空' })
        }
        else if (link_file_name_byte_length(value) > config.title_max_length) {
          issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: `标题太长了，最多 ${config.title_max_length} 字节` })
        }
        else if (has_attachment_illegal_char(value)) {
          // 标题沿用附件文件名的命名规范
          issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: '标题包含非法字符' })
        }
        else if (config.existing_titles?.some(item =>
          item.title.toLocaleLowerCase() === value.toLocaleLowerCase(),
        )) {
          issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: `标题『${value}』已被使用，请换一个标题` })
        }
        else {
          title = value
        }
        break
      }
      case 'label': {
        if (link_file_name_byte_length(value) > config.label_max_bytes) {
          issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: `标签太长了，最多 ${config.label_max_bytes} 字节` })
          break
        }
        const tokens = value.split(/\s+/).filter(Boolean)
        let failed = false
        const seen = new Set<string>()
        const seen_ratings = new Set<string>()
        for (const token of tokens) {
          if (seen.has(token)) {
            issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: `重复的标签 \`${token}\`` })
            failed = true
          }
          seen.add(token)
          if (token === pinned_label) {
            continue
          }
          if (token.startsWith('#')) {
            if (! content_rating_tiers.some(tier => rating_label(tier) === token)) {
              issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: `未知 # 标签 \`${token}\`，可选：${[... content_rating_tiers.map(rating_label), pinned_label].join(' ')}` })
              failed = true
            }
            else {
              seen_ratings.add(token)
            }
          }
        }
        // Literal duplicates are rejected above; conflicting rating # labels
        // (two different tiers) are a separate error — keep only one rating.
        if (seen_ratings.size > 1) {
          issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: `评分 # 标签冲突：${[... seen_ratings].join(' ')}，请只保留一个` })
          failed = true
        }
        if (! failed) {
          labels = tokens
        }
        break
      }
      case 'time': {
        const tokens = value.split('~').map(token => token.trim())
        if (! value || tokens.some(token => ! token) || tokens.length > 2) {
          issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: '时间格式应为 年/月/日、年/月，或用 ~ 连接起止时间' })
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
              issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: '时间不能混用『某天』和『某月』两种格式' })
              failed = true
              break
            }
            kind = 'day'
            const [, y, m, d] = day_match
            const year = Number(y)
            const month = Number(m)
            const day = Number(d)
            if (! is_real_date(year, month, day)) {
              issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: `不存在的日期：${token}` })
              failed = true
              break
            }
            entries.push(day_string(year, month, day))
          }
          else if (month_match) {
            if (kind === 'day') {
              issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: '时间不能混用『某天』和『某月』两种格式' })
              failed = true
              break
            }
            kind = 'month'
            const [, y, m] = month_match
            const year = Number(y)
            const month = Number(m)
            if (month < 1 || month > 12) {
              issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: `不存在的月份：${token}` })
              failed = true
              break
            }
            entries.push(month_string(year, month))
          }
          else {
            issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: `无法识别的时间：${token}（应为 年/月/日 或 年/月）` })
            failed = true
            break
          }
        }

        if (! failed && kind) {
          if (entries.length === 2 && entries[0]! > entries[1]!) {
            issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: '起始时间不能晚于结束时间' })
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
      case 'desc': {
        if (! value) {
          issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: '描述不能为空' })
        }
        else if (link_file_name_byte_length(value) > config.desc_max_bytes) {
          issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: `描述太长了，最多 ${config.desc_max_bytes} 字节` })
        }
        else if (/!?\[[^\]]*\]\([^)]*\)|<\/?[a-z][^>]*>/i.test(value)) {
          issues.push({ line: line_no, severity: 'warning', source: 'front-matter', message: '描述只支持纯文本，不支持链接或标记' })
        }
        else {
          desc = value
        }
        break
      }
      case 'cover': {
        // Accepts markdown image syntax `![alt](url)` or a bare URL/file name.
        // Any other value still carrying markdown bracket characters is
        // malformed image/link markdown (e.g. `![](a.jpg)123`, `![]](a.jpg)`),
        // not a bare URL — attachment file names are sanitized to exclude
        // these, so reject rather than storing the wrapper as the link.
        const image_match = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(value)
        const link = image_match ? image_match[2]! : value
        if (! link || /\s/.test(link) || (! image_match && /[[\]()]/.test(link))) {
          issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: 'cover 需为单个图片链接，如 ![](图片.jpg)' })
        }
        else if (link_file_name_byte_length(link) > config.cover_max_bytes) {
          issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: `cover 太长了，最多 ${config.cover_max_bytes} 字节` })
        }
        else {
          cover = link
          // The markdown label is the image alt text; a bare link has none.
          cover_label = image_match ? (image_match[1]?.trim() || null) : null
        }
        break
      }
      default:
        issues.push({ line: line_no, severity: 'error', source: 'front-matter', message: `不支持的字段 \`${key}\`，只允许 title / label / time / desc / cover` })
    }
  }

  if (front_matter_ok) {
    if (! seen_keys.has('title')) {
      issues.push({ line: 1, severity: 'error', source: 'front-matter', message: 'Front Matter 缺少 title 字段' })
    }
    if (! seen_keys.has('time')) {
      issues.push({ line: 1, severity: 'error', source: 'front-matter', message: 'Front Matter 缺少 time 字段' })
    }
  }

  // Body lines: dead `[](@title)` references lint as errors; a reference to
  // the story's own front-matter title is a self-reference and is rejected.
  const body_text = lines.slice(body_start).join('\n')
  for_each_link_span(body_text, (span, offset) => {
    if (! span.destination.startsWith('@')) {
      return
    }
    const reference_title = span.destination.slice(1)
    if (! reference_title) {
      return
    }
    const line_no = body_start + line_number_at(body_text, offset + span.start)
    const lower_title = reference_title.toLocaleLowerCase()
    if (lower_title === (title ?? '').toLocaleLowerCase()) {
      issues.push({ line: line_no, severity: 'error', source: 'at-story', message: '不允许自我引用' })
    }
    else if (! config.existing_titles?.some(item =>
      item.title.toLocaleLowerCase() === lower_title,
    )) {
      issues.push({ line: line_no, severity: 'error', source: 'at-story', message: `档案『${reference_title}』不可引用` })
    }
  })

  if (! front_matter_ok || issues.some(issue => issue.severity === 'error') || title === null || ! event_precision || ! event_entries.length) {
    return { meta: null, issues }
  }

  return {
    meta: { title, labels, event_precision, event_entries, desc, cover, cover_label },
    issues,
  }
}

/** Skeleton inserted into the editor when creating a new story; `today` is a `YYYY/M/D` local date. */
export function story_markdown_template(today: string) {
  return [
    '---',
    'title: 新建档案',
    `label: ${rating_label('人上人')}`,
    `time: ${today}`,
    '---',
    '',
  ].join('\n')
}

/** Lines occupied by the leading front matter block (0 when absent). */
export function front_matter_line_count(markdown: string) {
  const lines = markdown.split('\n')
  if (lines[0]?.trim() !== '---') {
    return 0
  }
  for (let i = 1; i < lines.length; i ++) {
    if (lines[i]?.trim() === '---') {
      return i + 1
    }
  }
  return 0
}

/** Remove the front matter block, leaving only the markdown body. */
export function strip_front_matter(markdown: string) {
  const count = front_matter_line_count(markdown)
  return count ? markdown.split('\n').slice(count).join('\n') : markdown
}

/** Root-relative URL path for an attachment (the static host prefixes it at render time). */
export function attachment_url_path(story_id: number, file_name: string) {
  // Folder paths (`a/b/file.png`) keep their slashes; each segment is encoded.
  const encoded = file_name.split('/').map(encodeURIComponent).join('/')
  return `/content/${story_id}/${encoded}`
}

/** The folder path of an attachment path (`a/b/c.png` → `a/b`), or null for root files. */
export function attachment_folder_of(file_name: string) {
  const slash = file_name.lastIndexOf('/')
  return slash > 0 ? file_name.slice(0, slash) : null
}

// Extension → mime map for attachment display (icon/image detection); OSS
// listings carry no content type, so types are derived from the file name.
const attachment_mime_by_extension: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  webm: 'video/webm',
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  csv: 'text/csv',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  pdf: 'application/pdf',
}

/** Best-effort mime type from the file extension; null when unknown. */
export function attachment_mime_type(file_name: string) {
  const dot = file_name.lastIndexOf('.')
  if (dot <= 0)
    return null
  return attachment_mime_by_extension[file_name.slice(dot + 1).toLowerCase()] ?? null
}

/** The file name without its folder prefix. */
export function attachment_base_name(file_name: string) {
  return file_name.slice(file_name.lastIndexOf('/') + 1)
}

/** Join a folder and a base file name into an attachment path (null folder = root). */
export function attachment_path_join(folder: string | null, base_name: string) {
  return folder ? `${folder}/${base_name}` : base_name
}

/**
 * Display order for attachment and folder paths, shared so the server and the
 * client cannot disagree.
 *
 * `numeric` is what puts `2.png` before `10.png`: a plain string comparison
 * settles on the first character, where '1' < '2', before the '0' is ever
 * considered — so numbered files would read 1, 10, 11, 2, 3. The locale keeps
 * Chinese names in a sensible order rather than UTF-8 code-point order.
 */
export function compare_attachment_names(left: string, right: string) {
  return left.localeCompare(right, 'zh-CN', { numeric: true })
}

/** The attachment fields the folder helpers read. */
export interface NamedAttachment {
  file_name: string
}

export interface ImageAttachment extends NamedAttachment {
  is_image: boolean
}

/** Destinations may be written with a trailing slash (`[](cards/)`). */
function normalize_folder_path(folder_path: string) {
  return folder_path.replace(/\/+$/, '').trim()
}

/**
 * Whether a destination names a folder in this scope. Folders only exist
 * implicitly here — the attachment list carries files, so a path is a folder
 * exactly when something lives under it. A file with the same name wins, so
 * `![](cards)` stays an image when `cards` really is a file.
 */
export function is_attachment_folder(attachments: readonly NamedAttachment[], folder_path: string) {
  const folder = normalize_folder_path(folder_path)
  if (! folder)
    return false
  if (attachments.some(item => item.file_name === folder))
    return false
  const prefix = `${folder}/`
  return attachments.some(item => item.file_name.startsWith(prefix))
}

/**
 * Images directly inside a folder, in display order, or null when the path is
 * not a folder. Direct children only: a subfolder is a folder in its own right
 * and can be referenced on its own.
 */
export function folder_images<T extends ImageAttachment>(attachments: readonly T[], folder_path: string): T[] | null {
  if (! is_attachment_folder(attachments, folder_path))
    return null
  const folder = normalize_folder_path(folder_path)
  return attachments
    .filter(item => item.is_image && attachment_folder_of(item.file_name) === folder)
    .sort((left, right) => compare_attachment_names(left.file_name, right.file_name))
}

/** Files at or below a folder, recursion included — the count the attachment list shows. */
export function folder_file_count(attachments: readonly NamedAttachment[], folder_path: string) {
  const folder = normalize_folder_path(folder_path)
  if (! folder)
    return 0
  const prefix = `${folder}/`
  return attachments.filter(item => item.file_name.startsWith(prefix)).length
}

/** All ancestor folder paths of a path, deepest last (`a/b/c.png` → ['a', 'a/b']); empty at root. */
export function attachment_ancestor_folders(path: string) {
  const folders: string[] = []
  let folder = attachment_folder_of(path)
  while (folder) {
    folders.unshift(folder)
    folder = attachment_folder_of(folder)
  }
  return folders
}

/** Windows-reserved device basenames; matched against the stem before the first dot. */
export const link_file_name_reserved_base = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function link_file_name_byte_length(name: string) {
  return new TextEncoder().encode(name).length
}

/** Normalize an uploaded file name; must match what the server stores. `max_bytes` comes from env (common filesystems cap one name at 255 bytes). */
export function sanitize_attachment_file_name(raw: string, max_bytes: number) {
  const base = raw.replaceAll('\\', '/').split('/').pop() ?? ''
  let cleaned = base.replace(link_file_name_illegal_chars, '').trim().replace(/^\.+/, '').replace(/\.+$/, '')
  if (link_file_name_reserved_base.test(cleaned.split('.')[0] ?? '')) {
    cleaned = `_${cleaned}`
  }
  let bytes = 0
  let truncated = ''
  for (const char of cleaned) {
    const size = link_file_name_byte_length(char)
    if (bytes + size > max_bytes) {
      break
    }
    bytes += size
    truncated += char
  }
  return truncated || 'file'
}

/** Normalize a (possibly nested) upload path (`folder/name.png`) the way the server stores it. */
export function sanitize_attachment_path(raw: string, max_bytes: number) {
  const segments = raw.replaceAll('\\', '/').split('/').filter(Boolean)
    .map(segment => sanitize_attachment_file_name(segment, max_bytes))
  return segments.join('/') || 'file'
}

/** Story-local URL used inside Markdown attachment links. */
export function attachment_markdown_path(file_name: string) {
  // Stored names are sanitized at the boundary (upload/rename) to exclude every
  // character that would break a raw markdown destination, so no encoding here.
  return file_name
}

interface MarkdownLinkSpan {
  /** Index of the leading `!` (images) or `[` (links). */
  start: number
  /** Index just past the closing `)`. */
  end: number
  image: boolean
  /** Raw label source between the outer brackets (may itself contain links). */
  label: string
  /** Index just past the opening `[`. */
  label_start: number
  /** Index of the closing `]`. */
  label_end: number
  /** Raw destination, unwrapped from `<...>`. */
  destination: string
  /** Start of the raw destination within the source. */
  dest_start: number
  /** End of the raw destination within the source. */
  dest_end: number
}

// Link parsing is a real scanner, not a regex: labels can nest `[...]` pairs
// (e.g. `![alt [](a.zip)](b.jpg)`), which a `[^\]]*` class cannot survive —
// the regex consumed the nested link and orphaned the outer destination.
// eslint-disable-next-line regexp/no-obscure-range -- CommonMark's four ASCII punctuation ranges are obscure by definition
const ascii_punctuation = /[!-/:-@[-`{-~]/

function is_escaped(text: string, index: number) {
  return text[index] === '\\' && index + 1 < text.length && ascii_punctuation.test(text[index + 1]!)
}

// A code span opens with a run of N backticks and closes with a run of exactly
// N; its contents (brackets included) are literal text, never link structure.
function code_span_end(text: string, start: number, limit: number) {
  let i = start
  while (i < limit && text[i] === '`') {
    i ++
  }
  const ticks = i - start
  let j = i
  while (j < limit) {
    if (text[j] !== '`') {
      j ++
      continue
    }
    let k = j
    while (k < limit && text[k] === '`') {
      k ++
    }
    if (k - j === ticks) {
      return k
    }
    j = k
  }
  return - 1
}

// Fenced code blocks never render links. Line-based ranges; indented code
// blocks (4-space) are not tracked — content there is still over-caught,
// which only protects attachments from deletion, never the reverse.
function fenced_code_ranges(text: string): [number, number][] {
  const ranges: [number, number][] = []
  let open: { marker: string, length: number, start: number } | null = null
  let offset = 0
  for (const line of text.split('\n')) {
    if (! open) {
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (fence) {
        open = { marker: fence[1]![0]!, length: fence[1]!.length, start: offset }
      }
    }
    else {
      const fence = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (fence && fence[1]![0] === open.marker && fence[1]!.length >= open.length) {
        ranges.push([open.start, offset + line.length])
        open = null
      }
    }
    offset += line.length + 1
  }
  if (open) {
    ranges.push([open.start, text.length])
  }
  return ranges
}

/** Try to parse an inline link/image starting at `text[start]` (`!` or `[`), within [.., limit). */
function parse_link_at(text: string, start: number, limit: number): MarkdownLinkSpan | null {
  const image = text[start] === '!'
  const open = image ? start + 1 : start

  // Balanced label: nested brackets allowed; `\`-escapes and code spans are
  // literal and do not count toward the balance.
  let depth = 1
  let i = open + 1
  while (i < limit && depth > 0) {
    if (text[i] === '`') {
      const end = code_span_end(text, i, limit)
      i = end === - 1 ? i + 1 : end
      continue
    }
    if (is_escaped(text, i)) {
      i += 2
      continue
    }
    if (text[i] === '[') {
      depth ++
    }
    else if (text[i] === ']') {
      depth --
    }
    i ++
  }
  if (depth !== 0 || text[i] !== '(') {
    return null
  }
  const label_start = open + 1
  const label_end = i - 1
  i ++

  while (i < limit && /\s/.test(text[i]!)) {
    i ++
  }
  let dest_start: number
  let dest_end: number
  if (text[i] === '<') {
    const close = text.indexOf('>', i + 1)
    if (close === - 1 || close >= limit) {
      return null
    }
    dest_start = i + 1
    dest_end = close
    i = close + 1
  }
  else {
    dest_start = i
    while (i < limit && ! /[\s()<>]/.test(text[i]!)) {
      i ++
    }
    dest_end = i
    if (dest_end === dest_start) {
      return null
    }
  }

  while (i < limit && /\s/.test(text[i]!)) {
    i ++
  }
  if (text[i] === '"') {
    const close = text.indexOf('"', i + 1)
    if (close === - 1 || close >= limit) {
      return null
    }
    i = close + 1
    while (i < limit && /\s/.test(text[i]!)) {
      i ++
    }
  }
  if (text[i] !== ')') {
    return null
  }
  return {
    start,
    end: i + 1,
    image,
    label: text.slice(label_start, label_end),
    label_start,
    label_end,
    destination: text.slice(dest_start, dest_end),
    dest_start,
    dest_end,
  }
}

/** All top-level inline link/image spans; labels may contain nested links (walked separately). */
function scan_markdown_links(text: string): MarkdownLinkSpan[] {
  const spans: MarkdownLinkSpan[] = []
  const fenced = fenced_code_ranges(text)
  let fence_index = 0
  let cursor = 0
  // Scan the non-fenced segments one at a time so a code span can never
  // "close" inside a fenced block and swallow it.
  while (cursor <= text.length) {
    while (fence_index < fenced.length && cursor >= fenced[fence_index]![1]) {
      fence_index ++
    }
    const limit = fence_index < fenced.length ? fenced[fence_index]![0] : text.length
    let i = cursor
    while (i < limit) {
      if (text[i] === '`') {
        const end = code_span_end(text, i, limit)
        i = end === - 1 ? i + 1 : end
        continue
      }
      if (is_escaped(text, i)) {
        i += 2
        continue
      }
      if (text[i] === '[' || (text[i] === '!' && text[i + 1] === '[')) {
        const span = parse_link_at(text, i, limit)
        if (span) {
          spans.push(span)
          i = span.end
          continue
        }
      }
      i ++
    }
    if (fence_index >= fenced.length) {
      break
    }
    cursor = fenced[fence_index]![1]
  }
  return spans
}

/** Walk every link span, including links nested inside labels (e.g. in image alt text). */
function for_each_link_span(text: string, visit: (span: MarkdownLinkSpan, offset: number) => void, offset = 0) {
  for (const span of scan_markdown_links(text)) {
    visit(span, offset)
    for_each_link_span(span.label, visit, offset + span.label_start)
  }
}

/** 1-based line number of `index` within `text`. */
function line_number_at(text: string, index: number) {
  let line = 1
  for (let i = 0; i < index; i ++) {
    if (text[i] === '\n') {
      line ++
    }
  }
  return line
}

interface MarkdownLinkPatch {
  label?: string
  destination?: string
}

/** Rebuild `text` from its link spans, applying per-span label/destination patches. */
function rewrite_markdown_links(text: string, patch: (span: MarkdownLinkSpan) => MarkdownLinkPatch | null) {
  const spans = scan_markdown_links(text)
  let out = ''
  let cursor = 0
  for (const span of spans) {
    const change = patch(span)
    if (! change) {
      continue
    }
    out += text.slice(cursor, span.start)
      + text.slice(span.start, span.label_start)
      + (change.label ?? text.slice(span.label_start, span.label_end))
      + text.slice(span.label_end, span.dest_start)
      + (change.destination ?? text.slice(span.dest_start, span.dest_end))
      + text.slice(span.dest_end, span.end)
    cursor = span.end
  }
  return out + text.slice(cursor)
}

/** Attachment paths are bare names or folder paths (`a/b/file.png`) — no empty segments. */
function is_attachment_path(name: string) {
  return name.split('/').every(Boolean)
}

function attachment_name_from_url(url: string) {
  // `@title` destinations are story references, not attachments.
  if (url.startsWith('@') || url.startsWith('#') || /^[a-z][\w+.-]*:/i.test(url)) {
    return null
  }

  if (! url) {
    return null
  }
  try {
    const decoded = decodeURIComponent(url)
    return is_attachment_path(decoded) ? decoded : null
  }
  catch {
    return is_attachment_path(url) ? url : null
  }
}

/** Extract attachment file names referenced from the markdown body for a story. */
export function extract_attachment_names(markdown: string) {
  const names = new Set<string>()
  for_each_link_span(markdown, (span) => {
    const name = attachment_name_from_url(span.destination)
    if (name) {
      names.add(name)
    }
  })
  return [... names]
}

/** Rename matching attachment URLs and default link labels without touching custom labels. */
export function rename_attachment_references(markdown: string, old_file_name: string, new_file_name: string): string {
  const new_local_path = attachment_markdown_path(new_file_name)
  return rewrite_markdown_links(markdown, (span) => {
    // Links nested inside an image label (`![alt [](a.zip)](b.jpg)`) are
    // references too: rewrite the label recursively so they are not missed.
    const rewritten_label = rename_attachment_references(span.label, old_file_name, new_file_name)
    const destination = attachment_name_from_url(span.destination) === old_file_name ? new_local_path : undefined
    let label = rewritten_label === span.label ? undefined : rewritten_label
    if (destination && span.label === old_file_name) {
      label = new_file_name
    }
    if (destination === undefined && label === undefined) {
      return null
    }
    return { destination, label }
  })
}

/** Extract the `@story_title` titles referenced from the markdown body (deduplicated). */
export function extract_story_reference_titles(markdown: string) {
  const titles = new Set<string>()
  for_each_link_span(markdown, (span) => {
    if (span.destination.length > 1 && span.destination.startsWith('@')) {
      titles.add(span.destination.slice(1))
    }
  })
  return [... titles]
}

/** Rename `[](@old_title)` story references to `@new_title`; other text is left untouched. */
export function rename_story_references(markdown: string, old_title: string, new_title: string): string {
  return rewrite_markdown_links(markdown, (span) => {
    const rewritten_label = rename_story_references(span.label, old_title, new_title)
    const label = rewritten_label === span.label ? undefined : rewritten_label
    const destination = span.destination === `@${old_title}` ? `@${new_title}` : undefined
    if (destination === undefined && label === undefined) {
      return null
    }
    return { destination, label }
  })
}
