// One-off migration: rewrites the old private-content syntax (any element
// carrying the bare `good` attribute, e.g. `<span good>…</span>`) to the new
// `<good>…</good>` tag, in place on content_stories.markdown.
// Dry-run by default (prints every rewrite with context); --apply writes.
// Run: node_modules/.bin/esbuild --bundle --platform=node --format=esm \
//   --packages=external --alias:@shared=/app/server/shared --alias:@server=/app/server \
//   --outfile=.tmp/migrate-good.mjs scripts/migrate-private-good-tag.ts \
//   && node --env-file=.env .tmp/migrate-good.mjs [--apply]
import type { RowDataPacket } from 'mysql2/promise'
import { db } from '@server/lib/db'

interface StoryRow extends RowDataPacket {
  id: number
  markdown: string
}

const open_pattern = /<([a-z][\w-]*)((?:\s[^>\n]*)?)>/gi

function has_good_attr(attrs: string) {
  return /(?:^|\s)good(?=\s|$)/.test(attrs.replace(/"[^"]*"|'[^']*'/g, ''))
}

function find_close(src: string, from: number, tag: string) {
  const boundary = new RegExp(String.raw`<${tag}\b[^>]*>|<\/${tag}\s*>`, 'gi')
  boundary.lastIndex = from
  let depth = 1
  for (let match = boundary.exec(src); match !== null; match = boundary.exec(src)) {
    if (match[0].startsWith('</')) {
      depth --
    }
    else if (! match[0].endsWith('/>')) {
      depth ++
    }
    if (depth === 0) {
      return { start: match.index, end: match.index + match[0].length }
    }
  }
  return null
}

interface Rewrite {
  from: number
  to: number
  text: string
}

/** Collects the open/close tag rewrites (close first, then open) for one document. */
function collect_rewrites(markdown: string): Rewrite[] {
  const rewrites: Rewrite[] = []
  open_pattern.lastIndex = 0
  for (let match = open_pattern.exec(markdown); match !== null; match = open_pattern.exec(markdown)) {
    if (match[0].endsWith('/>') || ! has_good_attr(match[2] ?? '')) {
      continue
    }
    const tag = match[1]!.toLowerCase()
    const close = find_close(markdown, match.index + match[0].length, tag)
    if (! close) {
      console.warn(`  ! 未闭合 <${tag} good> @${match.index}，跳过`)
      continue
    }
    // Descend past the whole element so nested markers are not double-seen;
    // a nested old-style element's tags stay as-is inside the new <good>.
    rewrites.push({ from: close.start, to: close.end, text: '</good>' })
    rewrites.push({ from: match.index, to: match.index + match[0].length, text: '<good>' })
    open_pattern.lastIndex = close.end
  }
  return rewrites
}

function apply_rewrites(markdown: string, rewrites: Rewrite[]) {
  let out = markdown
  for (const rewrite of [... rewrites].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, rewrite.from) + rewrite.text + out.slice(rewrite.to)
  }
  return out
}

const apply = process.argv.includes('--apply')
const [stories] = await db.execute<StoryRow[]>(
  'SELECT id, markdown FROM content_stories WHERE markdown REGEXP ?',
  ['<[a-z]+[[:space:]]+good[[:space:]>]'],
)
console.log(`${stories.length} 篇档案含旧语法，模式：${apply ? 'APPLY' : 'DRY-RUN'}`)

for (const story of stories) {
  const rewrites = collect_rewrites(story.markdown)
  console.log(`\n#${story.id}: ${rewrites.length / 2} 处元素`)
  for (const rewrite of rewrites) {
    const before = story.markdown.slice(Math.max(0, rewrite.from - 30), rewrite.from)
    const old = story.markdown.slice(rewrite.from, rewrite.to)
    console.log(`  …${JSON.stringify(before)} 【${old} → ${rewrite.text}】`)
  }
  if (apply && rewrites.length) {
    const migrated = apply_rewrites(story.markdown, rewrites)
    await db.execute('UPDATE content_stories SET markdown = ?, revision = revision + 1 WHERE id = ?', [migrated, story.id])
    console.log('  ✓ 已写入')
  }
}
process.exit(0)
