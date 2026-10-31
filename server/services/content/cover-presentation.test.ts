import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@server/lib/db', () => ({ db: { execute: mocks.execute } }))
const { attachment_cover_url, list_cover_presentations } = await import('../content-attachments.service')
const base = { id: 4, story_id: 1, file_name: 'cover.png', object_key: 'normal-avif', version: 'v1', storage_bucket: 'public',
  is_private: 0, avif_key: 'normal-avif', jpeg_key: 'normal-jpeg', image_revision: 2,
  image_metadata: { width: 120, height: 80 }, lqip_jpeg: Buffer.from([255, 216, 255, 217]) } as Parameters<typeof attachment_cover_url>[1][number]
beforeEach(() => vi.resetAllMocks())

it('returns the public cover dimensions and bounded LQIP in the same lookup as its URL', async () => {
  mocks.execute.mockResolvedValue([[base]])
  const result = (await list_cover_presentations([{ story_id: 1, file_name: 'cover.png' }])).get('1:cover.png')!
  expect(result.url).toMatch(/^\/api\/content\/attachments\/4\?/)
  expect(result.image).toMatchObject({ width: 120, height: 80, revision: 2, lqip: 'data:image/jpeg;base64,/9j/2Q==' })
  expect(JSON.stringify(result)).not.toContain('normal-avif')
  expect(mocks.execute).toHaveBeenCalledTimes(2)
})

it('resolves case and Unicode variants after fetching the story scope', async () => {
  mocks.execute.mockResolvedValue([[{ ... base, file_name: 'Docs/É.png' }]])
  const result = await list_cover_presentations([{ story_id: 1, file_name: 'docs/E\u0301.PNG' }])
  expect(result.get('1:docs/E\u0301.PNG')?.url).toMatch(/^\/api\/content\/attachments\/4\?/)
  expect(mocks.execute.mock.calls[0]![1]).toEqual([1])
})

it('uses only the redaction metadata for a private cover and omits a private cover without a redaction', async () => {
  const private_row = { ... base, is_private: 1, redacted_avif_key: 'redacted-avif', redacted_jpeg_key: 'redacted-jpeg', redacted_revision: 3,
    redacted_metadata: { width: 40, height: 30 }, redacted_lqip_jpeg: Buffer.from([255, 216, 0, 255, 217]) }
  mocks.execute.mockResolvedValueOnce([[private_row]]).mockResolvedValueOnce([[private_row]])
    .mockResolvedValueOnce([[{ ... base, is_private: 1 }]]).mockResolvedValueOnce([[{ ... base, is_private: 1 }]])
  const result = (await list_cover_presentations([{ story_id: 1, file_name: 'cover.png' }])).get('1:cover.png')!
  expect(result.url).toContain('&role=redacted')
  expect(result.image).toEqual({ revision: 3, width: 40, height: 30, lqip: 'data:image/jpeg;base64,/9gA/9k=', has_original: false })
  expect(JSON.stringify(result)).not.toContain('/9j/2Q==')
  expect(await list_cover_presentations([{ story_id: 1, file_name: 'cover.png' }])).toEqual(new Map())
})

it('keeps unprocessed formats readable without fabricating image metadata', async () => {
  mocks.execute.mockResolvedValue([[{ ... base, avif_key: null, jpeg_key: null, image_revision: null }]])
  const result = (await list_cover_presentations([{ story_id: 1, file_name: 'cover.png' }])).get('1:cover.png')!
  expect(result.url).toBeTruthy()
  expect(result.image).toBeUndefined()
})

it.each([
  { name: 'cover.png', private_exists: true },
  { name: 'renamed.png', private_exists: true },
  { name: 'cover.png', private_exists: false },
])('does not substitute an independent public attachment: %j', async ({ name, private_exists }) => {
  const public_row = { ... base, id: 9, file_name: name }
  const private_row = { ... base, file_name: `${name}.good`, is_private: 1 }
  const rows = private_exists ? [private_row, public_row] : [public_row]
  mocks.execute.mockResolvedValue([rows])

  expect(attachment_cover_url(private_row.file_name, rows)).toBeNull()
  expect(await list_cover_presentations([{ story_id: 1, file_name: private_row.file_name }])).toEqual(new Map())
  expect(attachment_cover_url(public_row.file_name, rows)).toMatch(/^\/api\/content\/attachments\/9\?/)
})

it('keeps the cover on its own redaction and clears it when that redaction is removed', async () => {
  const public_row = { ... base, id: 9 }
  const private_row = { ... base, file_name: 'cover.png.good', is_private: 1,
    redacted_avif_key: 'redacted-avif', redacted_jpeg_key: 'redacted-jpeg', redacted_revision: 3,
    redacted_metadata: { width: 40, height: 30 }, redacted_lqip_jpeg: Buffer.from([255, 216, 0, 255, 217]) }
  const cover = { story_id: 1, file_name: private_row.file_name }
  mocks.execute.mockResolvedValue([[private_row, public_row]])
  const result = (await list_cover_presentations([cover])).get('1:cover.png.good')!
  expect(result.url).toMatch(/^\/api\/content\/attachments\/4\?.*&role=redacted$/)
  expect(result.image).toMatchObject({ width: 40, height: 30 })

  const without_redaction = { ... private_row, redacted_avif_key: null, redacted_jpeg_key: null }
  mocks.execute.mockResolvedValue([[without_redaction, public_row]])
  expect(attachment_cover_url(cover.file_name, [without_redaction, public_row])).toBeNull()
  expect(await list_cover_presentations([cover])).toEqual(new Map())
})
