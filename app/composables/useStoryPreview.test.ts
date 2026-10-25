import type { BilibiliVideoCard } from '@shared/types/bilibili'
import type { ContentStoryAttachment } from '@shared/types/content'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, createSSRApp, effectScope, h, nextTick, onScopeDispose, onServerPrefetch, ref, watch } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { useStoryPreview } from './useStoryPreview'

type Cards = Record<string, BilibiliVideoCard | null>
const boundary = vi.hoisted(() => ({ fetch: vi.fn() }))
const a = 'https://www.bilibili.com/video/BV1xx411c7mD'
const b = 'https://www.bilibili.com/video/BV1xx411c7mE'
const scopes: ReturnType<typeof effectScope>[] = []
let app: object
let cache = ref<Cards>({})
const prefetch: (() => Promise<void>)[] = []

function card(title: string): BilibiliVideoCard {
  return { bvid: 'BV1xx411c7mD', url: a, title, cover: 'https://i.example/cover.jpg', uploader: 'author', duration: 60, views: 10, likes: 2 }
}

function deferred() {
  let resolve!: (cards: Cards) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<Cards>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  app = {}
  cache = ref({})
  prefetch.length = 0
  boundary.fetch.mockReset().mockResolvedValue({})
  for (const [name, value] of Object.entries({ computed, watch, onScopeDispose }))
    vi.stubGlobal(name, value)
  vi.stubGlobal('useNuxtApp', () => app)
  vi.stubGlobal('useState', () => cache)
  vi.stubGlobal('useApi', () => ({ content: { get_bilibili_video_cards: boundary.fetch } }))
  vi.stubGlobal('onServerPrefetch', (fn: () => Promise<void>) => prefetch.push(fn))
})

afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
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
  const owner: ContentStoryAttachment = { id: 1, file_name: 'secret.png.good', mime_type: 'image/avif', file_size: 5, is_image: true, is_encrypted: false,
    is_private: true, url: '/private-normal', version: '1', image: private_image, encryption_key: 'PRIVATE_KEY',
    has_redacted: true, redacted_url: '/public-redacted', redacted_image: public_image }
  const denied = { ... owner, id: 2, file_name: 'denied.png.good', url: '/private-denied', has_redacted: false, redacted_url: null, redacted_image: undefined }
  const ordinary = { ... owner, id: 3, file_name: 'public.png', url: '/public', is_private: false, image: public_image, encryption_key: undefined }
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
  expect(preview.preview_attachments.value[0]).not.toHaveProperty('encryption_key')
  expect(owner).toMatchObject({ url: '/private-normal', image: private_image, encryption_key: 'PRIVATE_KEY' })
  preview.public_mode.value = false
  expect(preview.render_result.value.html).toContain('BLOCK_SECRET')
  expect(preview.render_result.value.images).toEqual(['/private-normal', '/private-denied', 'https://static.test/public'])
})

it('does not fetch video metadata hidden by the public secret-body projection', async () => {
  const preview = setup(`<good>\n[](${a})\n</good>`, true)
  await settle()
  await prefetch[0]!()
  expect(boundary.fetch).not.toHaveBeenCalled()
  expect(preview.render_result.value.html).not.toContain(a)
  preview.public_mode.value = false
  await settle()
  expect(boundary.fetch).toHaveBeenCalledExactlyOnceWith([a])
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
  preview.attachments.value = [{ file_name: 'images/a.png', url: '/a.png', is_image: true, is_encrypted: false, mime_type: 'image/png', file_size: 1, version: '1' }]
  preview.folder_openable.value = true
  expect(preview.render_result.value.images).toEqual(['https://static.test/a.png'])
  expect(preview.render_result.value.html).toContain('data-folder-card="images"')
  await settle()
  expect(boundary.fetch).not.toHaveBeenCalled()
})

it('reuses serialized cards and explicit nulls during hydration', async () => {
  cache.value = { [a]: card('SSR title'), [b]: null }
  const preview = setup(`[](${a})\n\n[](${b})`)
  expect(preview.render_result.value.html).toContain('SSR title')
  expect(preview.render_result.value.html).not.toContain('正在加载视频信息')
  await prefetch[0]!()
  await settle()
  expect(boundary.fetch).not.toHaveBeenCalled()
})

it('joins repeated renders and overlapping previews without duplicate requests or cache publications', async () => {
  const first = deferred()
  boundary.fetch.mockReturnValueOnce(first.promise)
  const one = setup(`[](${a})\n\n[](${a})`)
  setup(`[](${a})`)
  one.markdown.value += '\n\ntyped'
  await settle()
  expect(boundary.fetch).toHaveBeenCalledExactlyOnceWith([a])
  const published = vi.fn()
  const stop = watch(cache, published, { flush: 'sync' })
  first.resolve({ [a]: card('joined') })
  await settle()
  expect(one.render_result.value.html).toContain('joined')
  expect(published).toHaveBeenCalledOnce()
  stop()
})

it('requests only new links and displays a fast batch while an older request is still pending', async () => {
  const first = deferred()
  const second = deferred()
  boundary.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const preview = setup(`[](${a})`)
  preview.markdown.value += `\n\n[](${b})`
  await settle()
  expect(boundary.fetch.mock.calls).toEqual([[[a]], [[b]]])
  second.resolve({ [b]: card('fast B') })
  await settle()
  expect(preview.render_result.value.html).toContain('fast B')
  preview.markdown.value = `[](${b})`
  await settle()
  first.resolve({ [a]: card('late A') })
  await settle()
  expect(preview.render_result.value.html).toContain('fast B')
  expect(preview.render_result.value.html).not.toContain('late A')
  expect(boundary.fetch).toHaveBeenCalledTimes(2)
})

it('releases an unmounted consumer while a surviving preview can still adopt the shared reply', async () => {
  const flight = deferred()
  boundary.fetch.mockReturnValueOnce(flight.promise)
  const first = setup(`[](${a})`)
  const second = setup(`[](${a})`)
  first.unmount()
  flight.resolve({ [a]: card('survivor') })
  await settle()
  expect(second.render_result.value.html).toContain('survivor')
  expect(boundary.fetch).toHaveBeenCalledOnce()
})

it('does not publish late replies after all consumers unmount, and remount can retry', async () => {
  const flight = deferred()
  boundary.fetch.mockReturnValueOnce(flight.promise)
  const preview = setup(`[](${a})`)
  preview.unmount()
  flight.resolve({ [a]: card('abandoned') })
  await settle()
  expect(cache.value).toEqual({})
  boundary.fetch.mockResolvedValueOnce({ [a]: card('remounted') })
  const next = setup(`[](${a})`)
  await settle()
  expect(next.render_result.value.html).toContain('remounted')
  expect(boundary.fetch).toHaveBeenCalledTimes(2)
})

it('keeps placeholders on transport failure and retries on a later render change without a retry loop', async () => {
  const flight = deferred()
  boundary.fetch.mockReturnValueOnce(flight.promise)
  const preview = setup(`[](${a})`)
  flight.reject(new Error('offline'))
  await settle()
  expect(cache.value).toEqual({})
  expect(preview.render_result.value.html).toContain('正在加载视频信息')
  expect(boundary.fetch).toHaveBeenCalledOnce()
  boundary.fetch.mockResolvedValueOnce({ [a]: null })
  preview.markdown.value += '\n\nretry'
  await settle()
  expect(cache.value[a]).toBeNull()
  preview.markdown.value += '\n\nno retry for null'
  await settle()
  expect(boundary.fetch).toHaveBeenCalledTimes(2)
})

it('isolates pending requests and payload caches across Nuxt applications', async () => {
  const first = deferred()
  const second = deferred()
  boundary.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const one = setup(`[](${a})`)
  const first_cache = cache
  app = {}
  cache = ref({})
  const two = setup(`[](${a})`)
  expect(boundary.fetch).toHaveBeenCalledTimes(2)
  second.resolve({ [a]: card('second app') })
  await settle()
  expect(first_cache.value).toEqual({})
  expect(two.render_result.value.html).toContain('second app')
  first.resolve({ [a]: card('first app') })
  await settle()
  expect(one.render_result.value.html).toContain('first app')
  expect(two.render_result.value.html).not.toContain('first app')
})

it('awaits the real Vue server-prefetch hook and produces the same HTML from the serialized cache', async () => {
  vi.stubGlobal('onServerPrefetch', onServerPrefetch)
  const flight = deferred()
  boundary.fetch.mockReturnValueOnce(flight.promise)
  const component = { setup() {
    const preview = useStoryPreview(() => `[](${a})`, {
      story_id: () => null, attachments: () => [], stories: () => [], static_url: path => path, folder_card_openable: () => false,
    })
    return () => h('div', { innerHTML: preview.render_result.value.html })
  } }
  const rendered = renderToString(createSSRApp(component))
  flight.resolve({ [a]: card('server title') })
  const html = await rendered
  expect(html).toContain('server title')
  // Mirror the payload transfer, including the explicit null representation.
  cache = ref(JSON.parse(JSON.stringify(cache.value)))
  vi.stubGlobal('onServerPrefetch', () => {})
  const client = setup(`[](${a})`)
  expect(`<div>${client.render_result.value.html}</div>`).toBe(html)
  expect(boundary.fetch).toHaveBeenCalledOnce()
})
