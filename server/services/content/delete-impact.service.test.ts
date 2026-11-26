import { beforeEach, expect, it, vi } from 'vitest'

const execute = vi.hoisted(() => vi.fn())
vi.mock('@server/lib/db', () => ({ db: { execute } }))
const { get_delete_impact } = await import('./delete-impact.service')

beforeEach(() => execute.mockReset().mockResolvedValue([[]]))

it('checks every saved story without exposing references in private content', async () => {
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Target', markdown: '' }]])
    .mockResolvedValueOnce([[{ id: 2, title: 'Visible', markdown: '[](CONTENT://target?x=1)\n\n<good>\n[](content://Target)\n</good>' },
      { id: 3, title: 'Private only', markdown: '<good>\n[](content://Target)\n</good>' }]])
  const impact = await get_delete_impact({ kind: 'story', id: 1 }, false)
  expect(impact.sources).toEqual([{ story_id: 2, title: 'Visible', references: [{ target: 'target', line: 1, effect: 'missing' }] }])
})

it('includes private references for an authorized viewer and does not truncate at 200 links', async () => {
  const many = Array.from({ length: 205 }, (_, index) => `[](content://other${index})`).join(' ')
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Target', markdown: '' }]])
    .mockResolvedValueOnce([[{ id: 2, title: 'Private', markdown: `<good>\n${many} [](content://TARGET)\n</good>` }]])
  const impact = await get_delete_impact({ kind: 'story', id: 1 }, true)
  expect(impact.sources[0]?.references).toEqual([{ target: 'TARGET', line: 2, effect: 'missing' }])
})

it('rejects stale or out-of-scope attachment targets', async () => {
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Story', markdown: '' }]]).mockResolvedValueOnce([[]])
  await expect(get_delete_impact({ kind: 'attachment', id: 1, targets: [9] }, true)).rejects.toMatchObject({ statusCode: 409 })
})

it('reports original source line numbers after private content is redacted', async () => {
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Target', markdown: '' }]])
    .mockResolvedValueOnce([[{ id: 2, title: 'Visible', markdown: '<good>\nsecret\nmore\n</good>\n\n[](content://Target)' }]])
  const impact = await get_delete_impact({ kind: 'story', id: 1 }, false)
  expect(impact.sources[0]?.references[0]?.line).toBe(6)
})

it('reports saved cover and nested references for attachment deletion', async () => {
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Story', markdown: '---\ncover: att://Docs/cover.png\n---\n[](att://docs/sub/file)' }]])
    .mockResolvedValueOnce([[{ id: 9, file_name: 'docs', is_folder: 1 }]])
  const impact = await get_delete_impact({ kind: 'attachment', id: 1, targets: [9] }, true)
  expect(impact.sources[0]?.references).toEqual([
    { target: 'Docs/cover.png', line: 2, effect: 'missing' },
    { target: 'docs/sub/file', line: 4, effect: 'missing' },
  ])
})

it('ignores folder images in the published body and cloud draft', async () => {
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Story', markdown: '![](att://album/sub/)\n\n![](att://album/sub/photo.png)' }]])
    .mockResolvedValueOnce([[{ id: 9, file_name: 'album', is_folder: 1 }, { id: 10, file_name: 'album/sub', is_folder: 1 }]])
    .mockResolvedValueOnce([[{ markdown: '![旧写法][album]\n\n[album]: att://Album/Sub' }]])
  const impact = await get_delete_impact({ kind: 'attachment', id: 1, targets: [9] }, true)
  expect(impact.sources[0]?.references).toEqual([{ target: 'album/sub/photo.png', line: 3, effect: 'missing' }])
  expect(impact.cloud_draft_references).toBe(false)
})

it('checks the stored cover even when historical Markdown does not contain it', async () => {
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Story', markdown: 'body', cover: 'docs/cover.png' }]])
    .mockResolvedValueOnce([[{ id: 9, file_name: 'docs', is_folder: 1 }]])
  const impact = await get_delete_impact({ kind: 'attachment', id: 1, targets: [9] }, true)
  expect(impact.sources[0]?.references).toEqual([{ target: 'docs/cover.png', line: 0, effect: 'missing' }])
})

it('does not reveal a confidential stored cover to an unauthorized viewer', async () => {
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Story', markdown: 'body', cover: 'secret.png.good' }]])
    .mockResolvedValueOnce([[{ id: 9, file_name: 'secret.png.good', is_folder: 0, is_private: 1, object_key: 'secret' }]])
  const impact = await get_delete_impact({ kind: 'attachment', id: 1, targets: [9] }, false)
  expect(impact.sources).toEqual([])
})

const redaction_pair = [
  { id: 9, file_name: 'docs.good/photo.png', is_folder: 0, is_private: 0, object_key: 'redaction' },
  { id: 10, file_name: 'Docs.good/Photo.png.good', is_folder: 0, is_private: 1, object_key: 'full' },
]

it('reports the original reference locations and checks the cloud draft when deleting a paired redaction', async () => {
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Story', markdown: '<good>\n![photo](att://DOCS.GOOD/PHOTO.PNG.GOOD)\n</good>' }]])
    .mockResolvedValueOnce([redaction_pair])
    .mockResolvedValueOnce([[{ markdown: '![draft photo](att://docs.good/photo.png.good)' }]])

  const impact = await get_delete_impact({ kind: 'attachment', id: 1, targets: [9] }, true)

  expect(impact.targets).toEqual([{ path: 'docs.good/photo.png', kind: 'file', redaction_of: 'Docs.good/Photo.png.good' }])
  expect(impact.sources[0]?.references).toEqual([{ target: 'DOCS.GOOD/PHOTO.PNG.GOOD', line: 2, effect: 'missing' }])
  expect(impact.cloud_draft_references).toBe(true)
  expect(execute).toHaveBeenCalledTimes(3)
  expect(execute).toHaveBeenNthCalledWith(2, expect.stringContaining('WHERE story_id = ?'), [1])
})

it.each([true, false])('reports a paired legacy cover only when confidential content is readable (can_private=%s)', async (can_private) => {
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Story', markdown: 'body', cover: 'docs.good/photo.png.good' }]])
    .mockResolvedValueOnce([redaction_pair])

  const impact = await get_delete_impact({ kind: 'attachment', id: 1, targets: [9] }, can_private)

  expect(impact.sources.flatMap(source => source.references)).toEqual(can_private ? [{ target: 'docs.good/photo.png.good', line: 0, effect: 'missing' }] : [])
  if (! can_private) {
    expect(impact.targets).toEqual([{ path: 'docs.good/photo.png', kind: 'file' }])
    expect(execute).toHaveBeenCalledTimes(2)
  }
})

it('finds only visible references for a paired redaction without confidential access', async () => {
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Story', markdown: '---\ncover: ![](att://docs.good/photo.png.good)\n---\n<good>\n![](att://docs.good/photo.png.good)\n</good>\n\n![](att://docs.good/photo.png.good)' }]])
    .mockResolvedValueOnce([redaction_pair])

  const impact = await get_delete_impact({ kind: 'attachment', id: 1, targets: [9] }, false)

  expect(impact.sources[0]?.references).toEqual([{ target: 'docs.good/photo.png.good', line: 8, effect: 'missing' }])
  expect(impact.targets).toEqual([{ path: 'docs.good/photo.png', kind: 'file' }])
  expect(impact.cloud_draft_references).toBe(false)
})

it('includes a directly named public cover inside a confidential folder', async () => {
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Story', markdown: 'body', cover: 'docs.good/photo.png' }]])
    .mockResolvedValueOnce([redaction_pair])

  const impact = await get_delete_impact({ kind: 'attachment', id: 1, targets: [9] }, false)

  expect(impact.sources[0]?.references).toEqual([{ target: 'docs.good/photo.png', line: 0, effect: 'missing' }])
})

it('does not guess a redaction relationship from a name alone', async () => {
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Story', markdown: '![photo](att://docs.good/photo.png.good)' }]])
    .mockResolvedValueOnce([[redaction_pair[0], { ... redaction_pair[1], is_private: 0 }]])

  const impact = await get_delete_impact({ kind: 'attachment', id: 1, targets: [9] }, true)

  expect(impact.targets).toEqual([{ path: 'docs.good/photo.png', kind: 'file' }])
  expect(impact.sources).toEqual([])
})
