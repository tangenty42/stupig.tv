import type { ContentDraftSummary } from '@shared/types/content-draft'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, Suspense } from 'vue'
import DraftList from './DraftList.vue'

interface DraftListPayload { items: ContentDraftSummary[], channel: string }

function snapshot(... titles: string[]): DraftListPayload {
  return { items: titles.map(title => ({ id: title, story_id: null, title, updated_at: '2026-11-23T00:00:00Z' })), channel: 'content_drafts:all' }
}

const refresh = vi.fn(async () => {})
let model: {
  data: ReturnType<typeof ref<DraftListPayload | null>>
  error: ReturnType<typeof ref<unknown>>
  loading: ReturnType<typeof ref<boolean>>
  ready: Promise<{ refresh: typeof refresh }>
  refresh: typeof refresh
}
vi.mock('~/features/content/draft-list', () => ({ useContentDraftList: () => model }))

const wrappers: { unmount: () => void }[] = []
const stubs = { MyContentStoryCard: { props: ['draft'], template: '<article>{{ draft.title }}</article>' } }

beforeEach(() => {
  refresh.mockReset().mockImplementation(async () => {
    model.loading.value = true
  })
  model = { data: ref(null), error: ref(null), loading: ref(true), ready: Promise.resolve({ refresh }), refresh }
})

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
})

async function open() {
  const wrapper = await mountSuspended(DraftList, { global: { stubs } })
  wrappers.push(wrapper)
  return wrapper
}

it('keeps a skeleton when the browser-only request has not settled instead of showing a false empty list', async () => {
  const wrapper = await open()
  expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('正在加载草稿')
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('还没有草稿')
})

it('shows a retryable first-load failure and only shows the empty state after a successful empty response', async () => {
  model.error.value = new Error('offline')
  model.loading.value = false
  const wrapper = await open()
  expect(wrapper.get('[role="alert"]').text()).toBe('重新加载')
  expect(wrapper.text()).not.toContain('还没有草稿')
  await wrapper.get('button').trigger('click')
  expect(refresh).toHaveBeenCalledOnce()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.find('[role="status"]').exists()).toBe(true)
  model.data.value = snapshot()
  model.error.value = null
  model.loading.value = false
  await nextTick()
  expect(wrapper.text()).toContain('还没有草稿~')
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
})

it('shows a settled missing response as failure even when the query suppresses its error callback', async () => {
  model.loading.value = false
  const wrapper = await open()
  expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  expect(wrapper.text()).not.toContain('还没有草稿')
})

it('keeps loaded cards while a background refresh fails and while retry is pending', async () => {
  model.data.value = snapshot('retained draft')
  model.loading.value = false
  const wrapper = await open()
  model.error.value = new Error('background failure')
  await nextTick()
  expect(wrapper.get('article').text()).toBe('retained draft')
  expect(wrapper.get('[role="alert"]').text()).toBe('重新加载')
  await wrapper.get('button').trigger('click')
  expect(wrapper.get('article').text()).toBe('retained draft')
  expect(wrapper.find('[role="status"]').exists()).toBe(false)
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.attributes('aria-busy')).toBe('true')
})

it('renders the full draft list without pagination controls', async () => {
  model.data.value = snapshot(... Array.from({ length: 32 }, (_, i) => `草稿 ${i + 1}`))
  model.loading.value = false
  const wrapper = await open()
  expect(wrapper.findAll('article')).toHaveLength(32)
  expect(wrapper.findAll('button')).toHaveLength(0)
})

it('holds the published view until the first draft request settles during a client-side switch', async () => {
  let resolve!: (handle: { refresh: typeof refresh }) => void
  model.ready = new Promise((done) => {
    resolve = done
  })
  const drafts = ref(false)
  const Host = defineComponent({ setup: () => () => h(Suspense, { timeout: - 1 }, { default: () => drafts.value ? h(DraftList) : h('p', { 'data-published': '' }, 'published') }) })
  const wrapper = await mountSuspended(Host, { global: { stubs } })
  wrappers.push(wrapper)
  drafts.value = true
  await flushPromises()
  expect(wrapper.find('[data-published]').exists()).toBe(true)
  expect(wrapper.find('[role="status"]').exists()).toBe(false)
  model.data.value = snapshot('new draft')
  model.loading.value = false
  resolve({ refresh })
  await flushPromises()
  expect(wrapper.find('[data-published]').exists()).toBe(false)
  expect(wrapper.get('article').text()).toBe('new draft')
})
