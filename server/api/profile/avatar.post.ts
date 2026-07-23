import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { ApiError } from '@server/errors/ApiError'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { resolve_operate_target } from '@server/services/auth-guards.service'
import { update_profile_avatar } from '@server/services/profile.service'
import { ok } from '@server/types/response'

const mime_to_ext: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}
const allowed_ext = new Set(['.jpg', '.jpeg', '.png', '.webp'])

export default defineEventHandler(async (event) => {
  const files = await readMultipartFormData(event)

  if (! files?.length) {
    throw new ApiError(400, '请先选择头像文件')
  }

  const operate_for_raw = files.find(item => item.name === 'operate_for')?.data?.toString()
  const operate_for = operate_for_raw ? Number(operate_for_raw) : null

  const { target_id } = await resolve_operate_target(event, Number.isInteger(operate_for) && operate_for ! > 0 ? operate_for : null)

  const avatar_file = files.find(item => item.name === 'avatar')

  if (! avatar_file?.data?.length) {
    throw new ApiError(400, '头像文件为空')
  }

  const config = useRuntimeConfig(event)
  const max_avatar_size_mb = config.public.max_avatar_size_mb as number
  const max_avatar_size = max_avatar_size_mb * 1024 * 1024

  if (avatar_file.data.length > max_avatar_size) {
    throw new ApiError(413, `头像文件太大了，不能超过 ${max_avatar_size_mb}MB`)
  }

  const mime_type = avatar_file.type ?? ''
  const ext_from_mime = mime_to_ext[mime_type]
  const ext_from_name = extname(avatar_file.filename ?? '').toLowerCase()
  const file_ext = ext_from_mime || (allowed_ext.has(ext_from_name) ? (ext_from_name === '.jpeg' ? '.jpg' : ext_from_name) : '')

  if (! file_ext) {
    throw new ApiError(415, '只支持 JPG / PNG / WebP')
  }

  const file_name = `${target_id}_${Date.now().toString(36)}${file_ext}`
  const { previous_file } = await update_profile_avatar(target_id, file_name)

  const avatar_dir = join(config.static_root, 'avatar')

  await mkdir(avatar_dir, { recursive: true })
  await writeFile(join(avatar_dir, file_name), avatar_file.data)

  if (previous_file && previous_file !== file_name) {
    try {
      await unlink(join(avatar_dir, previous_file))
    }
    catch {
    }
  }

  publish_refresh({ resource: sync_resource('profile', target_id) })
  publish_refresh({ resource: sync_resource('auth_user', target_id) })

  return ok(null, '头像已更新')
})
