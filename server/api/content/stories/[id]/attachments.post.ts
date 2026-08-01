import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { ApiError } from '@server/errors/ApiError'
import { require_admin_user } from '@server/services/auth-guards.service'
import { add_attachment, attachment_name_taken } from '@server/services/content.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

// Script-executable types are rejected: attachments are served from the static
// host, and these could turn an upload into stored XSS there.
const blocked_ext = new Set(['.html', '.htm', '.svg', '.xml', '.js', '.mjs', '.xhtml'])

function sanitize_file_name(raw: string): string {
  const base = raw.replaceAll('\\', '/').split('/').pop() ?? ''

  const cleaned = base.replace(/[<>"?*:|]/g, '_').trim().replace(/^\.+/, '')
  return cleaned.slice(0, 120) || 'file'
}

export default defineEventHandler(async (event) => {
  await require_admin_user(event)

  const { id } = schema.content_story_id.parse(event.context.params)

  const files = await readMultipartFormData(event)
  const upload = files?.find(item => item.name === 'file')

  if (! upload?.data?.length) {
    throw new ApiError(400, '请先选择要上传的文件')
  }

  const config = useRuntimeConfig(event)
  const max_size_mb = config.public.max_content_attachment_size_mb as number
  if (upload.data.length > max_size_mb * 1024 * 1024) {
    throw new ApiError(413, `文件太大了，不能超过 ${max_size_mb} MB`)
  }

  const ext = extname(upload.filename ?? '').toLowerCase()
  if (blocked_ext.has(ext)) {
    throw new ApiError(415, '不支持该类型的文件')
  }

  let file_name = sanitize_file_name(upload.filename ?? 'file')
  if (await attachment_name_taken(id, file_name)) {
    const stem = ext ? file_name.slice(0, - ext.length) : file_name
    file_name = `${stem}-${Date.now().toString(36)}${ext}`
  }

  const attachment = await add_attachment(id, file_name, upload.type ?? null, upload.data.length)

  const dir = join(config.static_root, 'content', String(id))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file_name), upload.data)

  return ok(attachment, '附件已上传')
})
