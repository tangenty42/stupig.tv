import type { ContentAttachmentWorkspace } from '@shared/types/content'
import { expect } from '@playwright/test'
import { content_query, create_story, editor_text, local_storage, login, test } from '../support/e2e-browser'

interface HashProbe {
  created: number
  completed: number
  errors: number
  terminated: number
  release: () => void
}

declare global {
  interface Window { __upload_hash_probe: HashProbe }
}

test('shows cancellable preparation before admission and hashes the original file only once', async ({ page }) => {
  test.setTimeout(180_000)
  await page.addInitScript(() => {
    const pending = new Map<Worker, () => void>()
    let hold = true
    const probe: HashProbe = { created: 0, completed: 0, errors: 0, terminated: 0,
      release() {
        hold = false
        for (const send of pending.values())
          send()
        pending.clear()
      },
    }
    window.__upload_hash_probe = probe
    const ActualWorker = window.Worker
    window.Worker = class extends ActualWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        let hashing = false
        this.addEventListener('message', (event) => {
          if (hashing && event.data?.type === 'done')
            probe.completed ++
        })
        this.addEventListener('error', () => {
          if (hashing)
            probe.errors ++
        })
        const send = this.postMessage.bind(this)
        this.postMessage = ((... args: unknown[]) => {
          const data = args[0]
          const forward = () => Reflect.apply(send, this, args)
          if (! hashing && data && typeof data === 'object' && 'file' in data && 'chunk_size' in data) {
            hashing = true
            probe.created ++
          }
          if (hold && hashing)
            pending.set(this, forward)
          else
            forward()
        }) as Worker['postMessage']
        const terminate = this.terminate.bind(this)
        this.terminate = () => {
          pending.delete(this)
          if (hashing)
            probe.terminated ++
          terminate()
        }
      }
    }
  })
  const admissions: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('content.beginUploadBatch'))
      admissions.push(request.url())
  })
  await login(page)
  const story = await create_story(page)
  await local_storage(page)
  const large = { name: 'large-preparation.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(9 * 1024 ** 2, 42) }
  const picker = page.getByLabel('选择上传文件', { exact: true })
  await picker.setInputFiles([large, { name: 'waiting.txt', mimeType: 'text/plain', buffer: Buffer.from('waiting') }])
  await expect(page.getByText(large.name, { exact: true })).toBeVisible()
  await expect(page.getByText('waiting.txt', { exact: true })).toBeVisible()
  await expect(page.getByText('等待准备', { exact: true })).toBeVisible()
  await expect(page.getByText('正在准备上传 · 0%', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '取消这批准备', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '添加', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '添加', exact: true }).locator('.animate-spin')).toHaveCount(0)
  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  await expect(editor).toBeEditable()
  await editor.press('Control+End')
  await editor.pressSequentially(' preparation stays editable')
  expect(await editor_text(page)).toContain('preparation stays editable')
  expect(admissions).toHaveLength(0)
  await page.getByText(large.name, { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '取消这批准备', exact: true }).click()
  await expect(page.getByText(large.name, { exact: true })).toHaveCount(0)
  await expect(page.getByText('waiting.txt', { exact: true })).toHaveCount(0)
  expect(admissions).toHaveLength(0)
  expect(await page.evaluate(() => window.__upload_hash_probe.terminated)).toBe(1)

  await page.evaluate(() => window.__upload_hash_probe.release())
  await picker.setInputFiles(large)
  await expect.poll(async () => (await content_query<ContentAttachmentWorkspace>(page, 'getAttachmentWorkspace', { id: Number(story.id) })).attachments.some(file => file.file_name === large.name && file.file_size === large.buffer.length)).toBe(true)
  await expect(page.getByRole('button', { name: '取消这批准备', exact: true })).toHaveCount(0)
  const probe = await page.evaluate(() => {
    const { created, completed, errors, terminated } = window.__upload_hash_probe
    return { created, completed, errors, terminated }
  })
  expect(probe).toEqual({ created: 2, completed: 1, errors: 0, terminated: 2 })
  expect(admissions).toHaveLength(1)
})
