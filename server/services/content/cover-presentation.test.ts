import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@server/lib/db', () => ({ db: { execute: mocks.execute } }))
const { list_cover_presentations } = await import('../content-attachments.service')
const base = { id: 4, story_id: 1, file_name: 'cover.png', object_key: 'normal-avif', version: 'v1', storage_bucket: 'public',
  is_private: 0, avif_key: 'normal-avif', jpeg_key: 'normal-jpeg', image_revision: 2,
  image_metadata: { width: 120, height: 80 }, lqip_jpeg: Buffer.from([255, 216, 255, 217]) }
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
