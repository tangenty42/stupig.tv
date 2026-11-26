import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@server/lib/db', () => ({ db: { execute: mocks.execute } }))
const { attachment_cover_url, list_cover_presentations } = await import('../content-attachments.service')
const base = { id: 4, story_id: 1, file_name: 'cover.png', object_key: 'normal-webp', version: 'v1', storage_bucket: 'public',
  is_private: 0, display_key: 'normal-webp', fallback_key: 'normal-jpeg', image_revision: 2,
  image_metadata: { width: 120, height: 80 }, lqip: Buffer.from([255, 216, 255, 217]) } as Parameters<typeof attachment_cover_url>[1][number]
beforeEach(() => vi.resetAllMocks())

it('returns the public cover dimensions and bounded LQIP in the same lookup as its URL', async () => {
  mocks.execute.mockResolvedValue([[base]])
  const result = (await list_cover_presentations([{ story_id: 1, file_name: 'cover.png' }])).get('1:cover.png')!
  expect(result.url).toMatch(/^\/api\/links\/attachments\/4\?/)
  expect(result.image).toMatchObject({ width: 120, height: 80, revision: 2, lqip: 'data:image/jpeg;base64,/9j/2Q==' })
  expect(JSON.stringify(result)).not.toContain('normal-webp')
  expect(mocks.execute).toHaveBeenCalledTimes(2)
})

it('resolves case and Unicode variants after fetching the story scope', async () => {
  mocks.execute.mockResolvedValue([[{ ... base, file_name: 'Docs/É.png' }]])
  const result = await list_cover_presentations([{ story_id: 1, file_name: 'docs/E\u0301.PNG' }])
  expect(result.get('1:docs/E\u0301.PNG')?.url).toMatch(/^\/api\/links\/attachments\/4\?/)
  expect(mocks.execute.mock.calls[0]![1]).toEqual([1])
})

it('shows the public 删减版 for a private cover and omits a private cover without one', async () => {
  const private_row = { ... base, file_name: 'cover.png.good', is_private: 1 }
  const twin = { ... base, id: 9, file_name: 'cover.png', image_metadata: { width: 40, height: 30 }, lqip: Buffer.from([255, 216, 0, 255, 217]) }
  mocks.execute.mockResolvedValueOnce([[private_row, twin]]).mockResolvedValueOnce([[private_row, twin]])
    .mockResolvedValueOnce([[private_row]]).mockResolvedValueOnce([[private_row]])
  const result = (await list_cover_presentations([{ story_id: 1, file_name: 'cover.png.good' }])).get('1:cover.png.good')!
  expect(result.url).toMatch(/^\/api\/links\/attachments\/9\?/)
  expect(result.image).toEqual({ revision: 2, width: 40, height: 30, lqip: 'data:image/jpeg;base64,/9gA/9k=', has_original: false })
  expect(await list_cover_presentations([{ story_id: 1, file_name: 'cover.png.good' }])).toEqual(new Map())
})

it('keeps unprocessed formats readable without fabricating image metadata', async () => {
  mocks.execute.mockResolvedValue([[{ ... base, display_key: null, fallback_key: null, image_revision: null }]])
  const result = (await list_cover_presentations([{ story_id: 1, file_name: 'cover.png' }])).get('1:cover.png')!
  expect(result.url).toBeTruthy()
  expect(result.image).toBeUndefined()
})

it.each([
  { private_name: 'cover.png.good', public_name: 'other.png', private_folder: false },
  { private_name: 'a.good/cover.png', public_name: 'a.good/cover.png.png', private_folder: true },
])('uses only the file named without `.good` in the same folder: %j', async ({ private_name, public_name }) => {
  const public_row = { ... base, id: 9, file_name: public_name }
  const private_row = { ... base, file_name: private_name, is_private: 1 }
  const rows = [private_row, public_row]
  mocks.execute.mockResolvedValue([rows])
  expect(attachment_cover_url(private_row.file_name, rows)).toBeNull()
  expect(await list_cover_presentations([{ story_id: 1, file_name: private_row.file_name }])).toEqual(new Map())
  expect(attachment_cover_url(public_row.file_name, rows)).toMatch(/^\/api\/links\/attachments\/9\?/)
})

it('follows a 删减版 inside a private folder and drops it when the 删减版 is removed', async () => {
  const twin = { ... base, id: 9, file_name: 'a.good/cover.png' }
  const private_row = { ... base, file_name: 'a.good/cover.png.good', is_private: 1 }
  expect(attachment_cover_url(private_row.file_name, [private_row, twin])).toMatch(/^\/api\/links\/attachments\/9\?/)
  expect(attachment_cover_url(private_row.file_name, [private_row])).toBeNull()
})
