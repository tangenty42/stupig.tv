import type { AuthUser } from '@server/types/auth'
import { content_image_formats } from '@shared/content-image-format'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ row: {} as Record<string, unknown>, sources: new Map<number, Record<string, unknown>>(), sign: vi.fn(), story_exists: true }))
vi.mock('@server/lib/esa', () => ({ create_esa: () => ({ signed_read_url: state.sign }) }))
vi.mock('@server/lib/aliyun-oss', () => ({ create_aliyun_oss: () => {
  throw new Error('Content browser reads must use ESA')
} }))
vi.mock('@server/lib/db', () => ({ db: { execute: async (sql: string, params: unknown[]) => {
  if (sql.includes('AND a.story_id = ?'))
    return [state.sources.has(Number(params[0])) ? [state.sources.get(Number(params[0]))] : []]
  return [state.story_exists ? [{ ... state.row }] : []]
} } }))
const { attachment_redirect, image_editor_source } = await import('./attachment-access.service')
const { attachment_access_version } = await import('@server/services/content-attachments.service')
const admin = { id: 7, session_id: 9, token_generation_id: 1, is_admin: true } as AuthUser
function version() {
  return attachment_access_version(state.row as Parameters<typeof attachment_access_version>[0])
}
beforeEach(() => {
  vi.clearAllMocks()
  state.story_exists = true
  state.sources.clear()
  state.row = { id: 11, read_revision: 1, object_key: 'content/att/key', storage_bucket: 'public', storage_provider: 'aliyun', oss_version_id: 'v1', version: 'etag', file_name: 'docs/报告 (1).PDF', is_private: 0, encryption_key: null }
  state.sign.mockReturnValue('https://esa.test/temporary')
})
describe('unified attachment reads', () => {
  it('serves only redacted pixels to guests and switches normal display with owner privacy', async () => {
    Object.assign(state.row, { is_private: 1, file_name: 'secret.png.good', display_key: 'secret.webp', fallback_key: 'secret.jpg', original_key: 'raw', image_revision: 1,
      redacted_display_key: 'redacted.webp', redacted_fallback_key: 'redacted.jpg', redacted_revision: 1 })
    await attachment_redirect(11, version(), null, 'GET', 'auto', 'image/webp')
    expect(state.sign.mock.lastCall?.[0]).toBe('redacted.webp')
    await attachment_redirect(11, version(), null, 'GET', 'auto', 'image/jpeg')
    expect(state.sign.mock.lastCall?.[0]).toBe('redacted.jpg')
    await expect(attachment_redirect(11, version(), null, 'GET', 'original')).rejects.toMatchObject({ statusCode: 403 })
    await attachment_redirect(11, version(), admin, 'GET', 'display')
    expect(state.sign.mock.lastCall?.[0]).toBe('secret.webp')
    state.row.is_private = 0
    await attachment_redirect(11, version(), null, 'GET', 'display')
    expect(state.sign.mock.lastCall?.[0]).toBe('secret.webp')
    await attachment_redirect(11, version(), null, 'GET', 'redacted_display')
    expect(state.sign.mock.lastCall?.[0]).toBe('redacted.webp')
    state.row.is_private = 1
    await attachment_redirect(11, version(), null, 'GET', 'display')
    expect(state.sign.mock.lastCall?.[0]).toBe('redacted.webp')
    const source = await image_editor_source(11, version(), admin, true)
    expect(source.display_url).toContain('role=redacted_display')
    expect(source.original_url).toContain('role=original')
    const old = version()
    state.row.redacted_display_key = state.row.redacted_fallback_key = null
    state.row.redacted_revision = 2
    await expect(attachment_redirect(11, old, null, 'GET', 'redacted_display')).rejects.toMatchObject({ statusCode: 403 })
  })
  it.each([true, false])('shares archive authorization with the redaction editor (variant exists: %s)', async (has_redacted) => {
    Object.assign(state.row, { story_id: 1, file_name: 'photo.png.good', is_private: 1, display_key: 'normal.webp', fallback_key: 'normal.jpg',
      original_key: 'archive', redacted_display_key: has_redacted ? 'redacted.webp' : null, redacted_fallback_key: has_redacted ? 'redacted.jpg' : null, redacted_revision: has_redacted ? 1 : 0 })
    const normal = await image_editor_source(11, version(), admin)
    const redacted = await image_editor_source(11, version(), admin, true)
    expect(redacted.original_url).toBe(normal.original_url)
    expect(redacted.original_url).toContain('role=original')
    expect(redacted.display_url).toContain(has_redacted ? 'role=redacted_display' : 'role=display')
    state.row.original_key = null
    const missing = await image_editor_source(11, version(), admin, true)
    expect(missing.original_url).toBeNull()
    expect(missing.original_reason).toBeTruthy()
    expect(missing.display_url).toContain(has_redacted ? 'role=redacted_display' : 'role=display')
  })
  it('never follows an ancestor when the attachment has no original', async () => {
    Object.assign(state.row, { story_id: 1, file_name: 'photo_副本.webp', display_key: 'copy.webp', fallback_key: 'copy.jpg', original_key: null,
      image_metadata: { archive_source_id: 22, archive_source_key: 'source-original' } })
    state.sources.set(22, { ... state.row, id: 22, original_key: 'source-original', image_metadata: { original: { name: 'source.PNG' } } })
    await attachment_redirect(11, version(), admin, 'GET', 'display')
    expect(state.sign).toHaveBeenLastCalledWith('copy.webp', expect.any(Number), 'GET', 'photo_副本.webp', 'inline', expect.any(Object))
    const editor = await image_editor_source(11, version(), admin)
    expect(editor.original_url).toBeNull()
    await expect(attachment_redirect(11, version(), admin, 'GET', 'original')).rejects.toMatchObject({ statusCode: 404 })
    expect(state.sign).toHaveBeenCalledOnce()
  })
  it('reads a detached copy archive without looking up a deleted or private source', async () => {
    Object.assign(state.row, { story_id: 1, file_name: 'photo_副本.webp', display_key: 'copy.webp', fallback_key: 'copy.jpg', original_key: 'copy-original',
      image_metadata: { original: { name: 'photo_副本.webp', mime: 'image/webp' }, archive_source_id: null, archive_source_key: null, source_id: null } })
    // No source rows exist. Only the copy itself may authorize these reads.
    await attachment_redirect(11, version(), null, 'GET', 'original')
    expect(state.sign).toHaveBeenLastCalledWith('copy-original', expect.any(Number), 'GET', 'photo_副本.webp', 'inline', expect.any(Object))
    expect((await image_editor_source(11, version(), admin)).original_url).toContain('role=original')
  })
  it.each(['gif', 'svg'])('serves an original %s directly and refuses the image editor', async (extension) => {
    Object.assign(state.row, { file_name: `original.${extension}`, display_key: null, fallback_key: null, original_key: null, image_metadata: null })
    await attachment_redirect(11, version(), null, 'GET', 'auto', 'image/webp,image/*')
    expect(state.sign).toHaveBeenLastCalledWith('content/att/key', expect.any(Number), 'GET', `original.${extension}`, 'inline', expect.any(Object))
    await expect(image_editor_source(11, version(), admin)).rejects.toMatchObject({ statusCode: 409 })
  })
  it('negotiates JPEG for display, uses explicit WebP for editing and preserves the original download name', async () => {
    Object.assign(state.row, { display_key: 'content/att/a.webp', fallback_key: 'content/att/a.jpg', original_key: 'content/att/raw', image_metadata: { original: { name: '未处理.PNG' } } })
    await attachment_redirect(11, version(), null, 'GET', 'auto', 'image/jpeg,image/*')
    expect(state.sign).toHaveBeenLastCalledWith('content/att/a.jpg', expect.any(Number), 'GET', '报告 (1).jpg', 'inline', expect.objectContaining({ id: 11, revision: expect.stringMatching(/^[a-f\d]{64}$/), session: expect.any(Number) }))
    await attachment_redirect(11, version(), null, 'GET', 'auto', 'image/webp,image/jpeg')
    expect(state.sign).toHaveBeenLastCalledWith('content/att/a.webp', expect.any(Number), 'GET', '报告 (1).webp', 'inline', expect.objectContaining({ id: 11, revision: expect.stringMatching(/^[a-f\d]{64}$/), session: expect.any(Number) }))
    await attachment_redirect(11, version(), null, 'GET', 'display')
    expect(state.sign).toHaveBeenLastCalledWith('content/att/a.webp', expect.any(Number), 'GET', '报告 (1).webp', 'inline', expect.objectContaining({ id: 11, revision: expect.stringMatching(/^[a-f\d]{64}$/), session: expect.any(Number) }))
    await attachment_redirect(11, version(), null, 'HEAD', 'original')
    expect(state.sign).toHaveBeenLastCalledWith('content/att/raw', expect.any(Number), 'HEAD', '未处理.png', 'inline', expect.objectContaining({ id: 11, revision: expect.stringMatching(/^[a-f\d]{64}$/), session: expect.any(Number) }))
  })

  it('keeps the fallback role and database fields when its physical format changes', async () => {
    const previous = content_image_formats.fallback
    Object.defineProperty(content_image_formats, 'fallback', { value: { extension: 'png', mime: 'image/png' } })
    try {
      Object.assign(state.row, { display_key: 'content/att/display.webp', fallback_key: 'content/att/fallback.png' })
      await attachment_redirect(11, version(), null, 'GET', 'auto', 'image/png,image/*')
      expect(state.sign).toHaveBeenLastCalledWith('content/att/fallback.png', expect.any(Number), 'GET', '报告 (1).png', 'inline', expect.objectContaining({ role: 'fallback' }))
    }
    finally {
      Object.defineProperty(content_image_formats, 'fallback', { value: previous })
    }
  })

  it('uses its own original even if obsolete provenance points elsewhere', async () => {
    Object.assign(state.row, { story_id: 1, original_key: 'content/att/own-original', image_metadata: { archive_source_id: 22, archive_source_key: 'content/att/old-archive' } })
    await attachment_redirect(11, version(), admin, 'GET', 'original')
    expect(state.sign.mock.lastCall?.[0]).toBe('content/att/own-original')
  })

  it.each(['GET', 'HEAD'] as const)('signs %s with the logical filename', async (method) => {
    expect(await attachment_redirect(11, version(), null, method)).toBe('https://esa.test/temporary')
    expect(state.sign).toHaveBeenCalledWith('content/att/key', expect.any(Number), method, '报告 (1).pdf', 'inline', expect.objectContaining({ id: 11, revision: expect.stringMatching(/^[a-f\d]{64}$/), session: expect.any(Number) }))
  })
  it.each([{ storage_provider: 'legacy' }, { encryption_key: 'old-key' }])('refuses legacy storage without signing: %j', async (legacy) => {
    Object.assign(state.row, legacy)
    await expect(attachment_redirect(11, version(), admin)).rejects.toMatchObject({ statusCode: 503 })
    expect(state.sign).not.toHaveBeenCalled()
  })
  it('checks current privacy even with a previously valid version', async () => {
    const old = version()
    state.row.is_private = 1
    await expect(attachment_redirect(11, old, null)).rejects.toMatchObject({ statusCode: 403 })
    await expect(attachment_redirect(11, old, admin)).rejects.toMatchObject({ statusCode: 409 })
    expect(state.sign).not.toHaveBeenCalled()
    await attachment_redirect(11, version(), admin)
    expect(state.sign).toHaveBeenCalledOnce()
  })
  it.each(['object_key', 'oss_version_id'])('fences a changed %s even with the same ETag', async (field) => {
    const old = version()
    state.row[field] = 'changed'
    await expect(attachment_redirect(11, old, null)).rejects.toMatchObject({ statusCode: 409 })
    expect(state.sign).not.toHaveBeenCalled()
  })
  it('never signs an orphaned attachment', async () => {
    state.story_exists = false
    await expect(attachment_redirect(11, version(), admin)).rejects.toMatchObject({ statusCode: 404 })
    expect(state.sign).not.toHaveBeenCalled()
  })
})
