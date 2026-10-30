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

it('checks the stored cover even when historical Markdown does not contain it', async () => {
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Story', markdown: 'body', cover: 'docs/cover.png' }]])
    .mockResolvedValueOnce([[{ id: 9, file_name: 'docs', is_folder: 1 }]])
  const impact = await get_delete_impact({ kind: 'attachment', id: 1, targets: [9] }, true)
  expect(impact.sources[0]?.references).toEqual([{ target: 'docs/cover.png', line: 0, effect: 'missing' }])
})

it('does not reveal a confidential stored cover to an unauthorized viewer', async () => {
  execute.mockResolvedValueOnce([[{ id: 1, title: 'Story', markdown: 'body', cover: 'secret.png.good' }]])
    .mockResolvedValueOnce([[{ id: 9, file_name: 'secret.png.good', is_folder: 0 }]])
  const impact = await get_delete_impact({ kind: 'attachment', id: 1, targets: [9] }, false)
  expect(impact.sources).toEqual([])
})
