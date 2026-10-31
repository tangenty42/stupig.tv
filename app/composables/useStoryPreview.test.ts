import type { ContentStoryAttachment } from '@shared/types/content'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, ref } from 'vue'
import { useStoryPreview } from './useStoryPreview'

const boundary = vi.hoisted(() => ({ api: vi.fn() }))
const a = 'iframe://player.bilibili.com/player.html?bvid=BV1xx411c7mD'
const scopes: ReturnType<typeof effectScope>[] = []

beforeEach(() => {
  boundary.api.mockReset()
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('useApi', boundary.api)
})

afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup(source: string, public_view = false) {
  const markdown = ref(source)
  const attachments = ref<ContentStoryAttachment[]>([])
  const folders = ref<string[]>([])
  const folder_openable = ref(false)
  const public_mode = ref(public_view)
  const scope = effectScope()
  scopes.push(scope)
  const result = scope.run(() => useStoryPreview(() => markdown.value, {
    story_id: () => 1, attachments: () => attachments.value, stories: () => [],
    folders: () => folders.value,
    static_url: path => `https://static.test${path}`, folder_card_openable: () => folder_openable.value,
    public_view: () => public_mode.value,
  }))!
  return { ... result, markdown, attachments, folders, folder_openable, public_mode, unmount: () => scope.stop() }
}

it('reacts to workspace directory creation, rename and deletion without needing child files', () => {
  const preview = setup('[](att://this_is_a_folder)')
  expect(preview.render_result.value.html).not.toContain('folder-card')
  preview.folders.value = ['this_is_a_folder']
  expect(preview.render_result.value.html).toContain('folder-card')
  expect(preview.render_result.value.html).toContain('0 个文件')
  preview.folders.value = ['renamed']
  expect(preview.render_result.value.html).not.toContain('folder-card')
  preview.markdown.value = '[](att://renamed)'
  expect(preview.render_result.value.html).toContain('folder-card')
  preview.folders.value = []
  expect(preview.render_result.value.html).not.toContain('folder-card')
})

it('switches the whole preview to the public body and attachment representation without mutating editing data', () => {
  const private_image = { revision: 1, width: 1200, height: 800, lqip: 'data:image/jpeg;base64,/9j/2Q==', has_original: true }
  const public_image = { revision: 2, width: 20, height: 10, lqip: 'data:image/jpeg;base64,/9j/AA==', has_original: false }
  const preview = setup('<good>\nBLOCK_SECRET\n</good>\n\ninline <good>INLINE_SECRET</good> text\n\n![caption](att://secret.png.good)\n\n![](att://denied.png.good)\n\n![](att://public.png)')
  const owner: ContentStoryAttachment = { id: 1, file_name: 'secret.png.good', mime_type: 'image/avif', file_size: 5, is_image: true,
    is_private: true, url: '/private-normal', version: '1', image: private_image,
    has_redacted: true, redacted_url: '/public-redacted', redacted_image: public_image }
  const denied = { ... owner, id: 2, file_name: 'denied.png.good', url: '/private-denied', has_redacted: false, redacted_url: null, redacted_image: undefined }
  const ordinary = { ... owner, id: 3, file_name: 'public.png', url: '/public', is_private: false, image: public_image }
  preview.attachments.value = [owner, denied, ordinary]
  expect(preview.render_result.value.html).toContain('BLOCK_SECRET')
  expect(preview.render_result.value.images).toEqual(['/private-normal', '/private-denied', 'https://static.test/public'])
  preview.public_mode.value = true
  const { html, images } = preview.render_result.value
  expect(html).not.toContain('BLOCK_SECRET')
  expect(html).not.toContain('INLINE_SECRET')
  expect(html).toContain('你无权查看此机密内容')
  expect(html).toContain('机密附件·删减版')
  expect(html).toContain('caption')
  expect(html).toContain('encrypted-image-denied')
  expect(html).not.toContain('/private-normal')
  expect(html).not.toContain('/private-denied')
  expect(html).not.toContain(private_image.lqip)
  expect(html).toContain(public_image.lqip)
  expect(/class="image-carousel" data-line="(\d+)"/.exec(html)?.[1]).toBe('6')
  expect(images).toEqual(['https://static.test/public-redacted', 'https://static.test/public'])
  expect(preview.preview_attachments.value[0]).not.toHaveProperty('image')
  expect(owner).toMatchObject({ url: '/private-normal', image: private_image })
  preview.public_mode.value = false
  expect(preview.render_result.value.html).toContain('BLOCK_SECRET')
  expect(preview.render_result.value.images).toEqual(['/private-normal', '/private-denied', 'https://static.test/public'])
})

it('renders visible videos without requesting metadata', () => {
  const preview = setup(`<good>\n![视频](${a})\n</good>`, true)
  expect(preview.render_result.value.html).not.toContain('player.bilibili.com')
  preview.public_mode.value = false
  expect(preview.render_result.value.html).toContain('player.bilibili.com')
  expect(boundary.api).not.toHaveBeenCalled()
})

async function settle() {
  await Promise.resolve()
  await nextTick()
  await nextTick()
}

it('renders reactive markdown and references through the existing preset without unrelated requests', async () => {
  const preview = setup('---\ntitle: hidden\n---\n\n# Heading\n\n![](att://images/a.png)\n\n[](att://images)')
  expect(preview.body_markdown.value).not.toContain('hidden')
  expect(preview.render_result.value.html).toContain('附件不存在或引用无效')
  preview.attachments.value = [{ file_name: 'images/a.png', url: '/a.png', is_image: true, mime_type: 'image/png', file_size: 1, version: '1' }]
  preview.folder_openable.value = true
  expect(preview.render_result.value.images).toEqual(['https://static.test/a.png'])
  expect(preview.render_result.value.html).toContain('data-folder-card="images"')
  await settle()
  expect(boundary.api).not.toHaveBeenCalled()
})
