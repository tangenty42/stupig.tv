import type { ContentStoryBody } from '@shared/types/content'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import StoryDetail from './index.vue'

const { mock_story_detail } = vi.hoisted(() => ({ mock_story_detail: vi.fn() }))
mockNuxtImport('useAuth', () => () => ({ user: ref(null) }))
vi.mock('~/features/content/stories', () => ({
  useContentStory: () => mock_story_detail(),
  useContentStories: () => ({ stories: ref([]), ready: Promise.resolve() }),
}))
vi.mock('~/features/content/attachments/panel', () => ({
  useAttachmentPanel: () => ({ catalog: { data: ref(null) }, ready: Promise.resolve() }),
}))

const saved_story = {
  id: 1,
  title: '测试档案',
  title_revision: 1,
  labels: [],
  desc: null,
  cover: null,
  cover_label: null,
  cover_url: null,
  cover_version: null,
  event_precision: 'day',
  event_dates: [],
  markdown: '',
  has_private: false,
  private_readable: true,
  revision: 1,
  namespace_revision: 1,
  viewer_key: 'public',
  representation_version: '1',
  created_at: '2026-11-25',
  updated_at: '2026-11-25',
} satisfies ContentStoryBody

function setup_story_detail(initial_story: ContentStoryBody | null) {
  const story = ref(initial_story)
  const loading = ref(false)
  const error = ref(false)
  const refresh = vi.fn(async () => {
    loading.value = true
  })
  const detail = { story, loading, error, refresh, ready: Promise.resolve({ refresh }) }
  mock_story_detail.mockReturnValue(detail)
  return detail
}

function mount_detail() {
  return mountSuspended(StoryDetail, { route: '/content/1', global: { stubs: {
    MyHeightSection: { template: '<section><slot /></section>' },
    MyContentMarkdownPreview: true,
    MyContentAttachmentWorkspace: true,
    MyContentStoryCalendar: true,
    MyIcon: true,
  } } })
}

it.each([
  { event_dates: [], date: '' },
  { event_dates: ['2026-11-24'], date: '2026 年 11 月 24 日' },
])('shows date text and a calendar only for an event with dates ($event_dates)', async ({ event_dates, date }) => {
  setup_story_detail({ ... saved_story, event_dates })
  const page = await mount_detail()
  try {
    expect(page.get('h1').text()).toBe('测试档案')
    expect(page.get('h1').element.nextElementSibling?.textContent?.trim() || '').toBe(date)
    expect(page.text().includes('事件日历')).toBe(Boolean(date))
    expect(page.find('my-content-story-calendar-stub').exists()).toBe(Boolean(date))
  }
  finally {
    page.unmount()
  }
})

it('retries a failed story load, showing loading and then the recovered story', async () => {
  const detail = setup_story_detail(null)
  detail.error.value = true
  const page = await mount_detail()
  try {
    expect(page.text()).not.toContain('档案不存在或已被删除')
    const retry = page.get('button[aria-label="重新加载"]')
    await retry.trigger('click')
    expect(detail.refresh).toHaveBeenCalledOnce()
    expect(page.find('[role="status"][aria-label="正在加载档案"]').exists()).toBe(true)
    expect(page.find('button[aria-label="重新加载"]').exists()).toBe(false)

    detail.story.value = saved_story
    detail.error.value = false
    detail.loading.value = false
    await nextTick()
    expect(page.get('h1').text()).toBe('测试档案')

    detail.error.value = true
    await nextTick()
    expect(page.get('h1').text()).toBe('测试档案')
    expect(page.find('button[aria-label="重新加载"]').exists()).toBe(false)
  }
  finally {
    page.unmount()
  }
})

it('shows the missing story message only for confirmed absence', async () => {
  setup_story_detail(null)
  const page = await mount_detail()
  try {
    expect(page.text()).toContain('档案不存在或已被删除')
    expect(page.find('button[aria-label="重新加载"]').exists()).toBe(false)
  }
  finally {
    page.unmount()
  }
})
