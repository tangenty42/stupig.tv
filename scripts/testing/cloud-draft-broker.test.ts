import { expect, it, vi } from 'vitest'
import { remove_cloud_draft_container } from './cloud-draft-broker'

const name = 'stupig-draft-qa-1234567890abcdef'

it('accepts a failed removal when Docker confirms the exact container is gone', async () => {
  const run = vi.fn().mockRejectedValueOnce(new Error('rm timed out')).mockResolvedValueOnce({ stdout: '' })
  await remove_cloud_draft_container(name, run)
  expect(run.mock.calls).toEqual([
    [['rm', '-f', '-v', name]],
    [['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']],
  ])
})

it.each([
  ['the container still exists', async () => ({ stdout: `${name}\n` })],
  ['Docker is unreachable', async () => { throw new Error('Docker unavailable') }],
] as const)('preserves the removal failure when %s', async (_case, list) => {
  const cause = new Error('rm timed out')
  const run = vi.fn().mockRejectedValueOnce(cause).mockImplementationOnce(list)
  await expect(remove_cloud_draft_container(name, run)).rejects.toMatchObject({ message: `Disposable broker cleanup failed: ${name}`, cause })
})
