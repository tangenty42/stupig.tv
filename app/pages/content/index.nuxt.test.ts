import type { ContentStorySummary } from '@shared/types/content'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import Calendar from '~/components/MyContent/Story/Calendar.vue'
import ContentIndex from './index.vue'

const stories: ContentStorySummary[] = [
  { id: 1, title: 'A', labels: ['#置顶', 'food'], event_dates: ['2026-09-01'] },
  { id: 2, title: 'B', labels: ['#夯', 'games'], event_dates: ['2026-10-10', '2026-11-10'] },
  { id: 3, title: 'C', labels: ['music'], event_dates: ['2026-12-01'] },
].map(story => ({
  ... story,
  event_precision: 'day',
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  desc: null,
  cover: null,
  cover_label: null,
  cover_url: null,
  cover_version: null,
}))

mockNuxtImport('useAuth', () => () => ({ user: ref(null) }))
const { override_stories_query } = vi.hoisted(() => ({ override_stories_query: vi.fn() }))
vi.mock('~/features/content/stories', () => ({
  useContentStories: () => override_stories_query() ?? {
    ready: Promise.resolve({ refresh: async () => {} }),
    stories: ref(stories),
    loading: ref(false),
  },
}))

const wrappers: { unmount: () => void }[] = []
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

it('pins stories in both sorts and shows the union of the selected labels', async () => {
  const page = await mountSuspended(ContentIndex, { global: { stubs: {
    MyHeightSection: { template: '<section><slot /></section>' },
    MyContentStoryCard: { props: ['story'], template: '<article :data-story="story.id" />' },
    MyContentStoryCalendar: true,
    MyDivider: true,
    MyIcon: { props: ['name'], template: '<span :data-icon="name" />' },
  } } })
  wrappers.push(page)
  // Both responsive layouts are mounted. Read the single-column list in order.
  const cards = () => [... page.get('[data-story]').element.parentElement!.children].map(card => card.getAttribute('data-story'))
  const badge = (label: string) => page.findAll('.badge-button').find(button => button.text() === label)!
  const sort = page.get('button[aria-label="排序"]')
  expect(cards()).toEqual(['1', '3', '2'])
  expect(sort.text()).toContain('排序：按时间')
  expect(sort.attributes('aria-pressed')).toBe('false')
  expect(sort.get('[data-icon]').attributes('data-icon')).toBe('lucide:calendar-days')
  await sort.trigger('click')
  expect(sort.text()).toContain('排序：按评分')
  expect(sort.attributes('aria-pressed')).toBe('true')
  expect(sort.get('[data-icon]').attributes('data-icon')).toBe('lucide:star')
  expect(cards()).toEqual(['1', '2', '3'])
  await badge('games').trigger('click')
  expect(cards()).toEqual(['2'])
  await badge('food').trigger('click')
  expect(cards()).toEqual(['1', '2'])
  await badge('清除').trigger('click')
  expect(cards()).toEqual(['1', '2', '3'])
})

it('shows a published list failure, then loading and the confirmed empty state after retry', async () => {
  const result = ref<ContentStorySummary[] | null>(null)
  const loading = ref(false)
  const response = Promise.withResolvers<ContentStorySummary[]>()
  const refresh = vi.fn(async () => {
    loading.value = true
    result.value = await response.promise
    loading.value = false
  })
  override_stories_query.mockReturnValueOnce({ stories: result, loading, ready: Promise.resolve({ refresh }) })
  const page = await mountSuspended(ContentIndex, { global: { stubs: {
    MyHeightSection: { template: '<section><slot /></section>' },
    MyContentStoryCalendar: true,
    MyDivider: true,
  } } })
  wrappers.push(page)

  expect(page.get('[role="alert"]').text()).toBe('重新加载')
  expect(page.text()).not.toContain('还没有档案~')
  expect(page.text()).not.toContain('0 份の')
  await page.get('button[aria-label="重新加载"]').trigger('click')
  expect(refresh).toHaveBeenCalledOnce()
  expect(page.find('[aria-label="正在加载已发布档案"]').exists()).toBe(true)
  expect(page.find('[role="alert"]').exists()).toBe(false)
  response.resolve([])
  await flushPromises()
  expect(page.text()).toContain('还没有档案~')
  expect(page.text()).toContain('0 份の')
  expect(page.find('[role="alert"]').exists()).toBe(false)
})

it('sorts a nonempty list without ordinary labels', async () => {
  const result = ref(stories.map(story => ({ ... story, labels: story.labels.filter(label => label.startsWith('#')) })))
  override_stories_query.mockReturnValueOnce({ stories: result, loading: ref(false), ready: Promise.resolve({ refresh: async () => {} }) })
  const page = await mountSuspended(ContentIndex, { global: { stubs: {
    MyHeightSection: { template: '<section><slot /></section>' },
    MyContentStoryCard: { props: ['story'], template: '<article :data-story="story.id" />' },
    MyContentStoryCalendar: true,
    MyDivider: true,
    MyIcon: true,
  } } })
  wrappers.push(page)
  const cards = () => page.findAll('[data-story]').slice(0, 3).map(card => card.attributes('data-story'))
  expect(cards()).toEqual(['1', '3', '2'])
  const sort = page.get('button[aria-label="排序"]')
  await sort.trigger('click')
  expect(sort.attributes('aria-pressed')).toBe('true')
  expect(cards()).toEqual(['1', '2', '3'])
})

it('can clear a selected label after an update removes all ordinary labels', async () => {
  const result = ref(stories)
  override_stories_query.mockReturnValueOnce({ stories: result, loading: ref(false), ready: Promise.resolve({ refresh: async () => {} }) })
  const page = await mountSuspended(ContentIndex, { global: { stubs: {
    MyHeightSection: { template: '<section><slot /></section>' },
    MyContentStoryCard: { props: ['story'], template: '<article :data-story="story.id" />' },
    MyContentStoryCalendar: true,
    MyDivider: true,
    MyIcon: true,
  } } })
  wrappers.push(page)
  const badge = (label: string) => page.findAll('.badge-button').find(button => button.text() === label)!
  await badge('games').trigger('click')
  result.value = stories.map(story => ({ ... story, labels: story.labels.filter(label => label.startsWith('#')) }))
  await flushPromises()
  expect(page.text()).toContain('没有符合筛选条件的档案~')
  expect(page.find('button[aria-label="排序"]').exists()).toBe(true)
  await badge('清除').trigger('click')
  expect(page.text()).not.toContain('没有符合筛选条件的档案~')
  expect(page.findAll('[data-story]')).toHaveLength(6)
})

it('passes list cover geometry and LQIP to the shared frame and switches to its failure placeholder', async () => {
  const story = {
    ... stories[0]!,
    cover: 'cover.jpg',
    cover_url: '/objects/cover.webp',
    cover_image: { width: 480, height: 240, revision: 1, lqip: 'data:image/jpeg;base64,/9j/2Q==', has_original: false },
  }
  override_stories_query.mockReturnValueOnce({
    stories: ref([story]),
    loading: ref(false),
    ready: Promise.resolve({ refresh: async () => {} }),
  })
  const page = await mountSuspended(ContentIndex, { global: { stubs: {
    MyHeightSection: { template: '<section><slot /></section>' },
    MyContentStoryCalendar: true,
    MyDivider: true,
    MyIcon: true,
  } } })
  wrappers.push(page)

  const frames = page.findAll<HTMLElement>('.story-card .img-frame')
  expect(frames).toHaveLength(2)
  for (const frame of frames) {
    expect(frame.attributes('data-image-sized')).toBeDefined()
    expect(frame.attributes('data-lqip')).toBeDefined()
    expect(frame.element.style.getPropertyValue('--content-image-ratio')).toBe('2')
    expect(frame.find('.image-lqip').exists()).toBe(true)
    const image = frame.get('img')
    expect(image.attributes('width')).toBe('480')
    await image.trigger('error')
    expect(frame.attributes('data-image-error')).toBeDefined()
    expect(frame.get('.image-unavailable').attributes('aria-label')).toBe('图片加载失败')
  }
})

it('shows undated stories first within each pin group in time order and omits their date rows', async () => {
  const undated = (story: ContentStorySummary, id: number) => ({ ... story, id, event_dates: [] })
  override_stories_query.mockReturnValueOnce({
    stories: ref([... stories, undated(stories[0]!, 4), undated(stories[2]!, 5)]),
    loading: ref(false),
    ready: Promise.resolve({ refresh: async () => {} }),
  })
  const page = await mountSuspended(ContentIndex, { global: { stubs: {
    MyHeightSection: { template: '<section><slot /></section>' },
    MyContentStoryCalendar: true,
    MyDivider: true,
    MyIcon: true,
  } } })
  wrappers.push(page)

  const cards = () => page.findAll('.story-card').slice(0, 5)
  const card_paths = () => cards().map(card => card.attributes('href'))
  expect(card_paths()).toEqual(['/content/4', '/content/1', '/content/5', '/content/3', '/content/2'])
  expect(cards().map(card => card.find('.story-card-date').exists())).toEqual([false, true, false, true, true])
  await page.get('button[aria-label="排序"]').trigger('click')
  expect(card_paths()).toEqual(['/content/1', '/content/4', '/content/2', '/content/3', '/content/5'])
})

const calendar_stories = [... stories, { ... stories[1]!, id: 4, event_dates: [] }]

it.each([
  { props: { stories: calendar_stories }, months: [12, 11, 10, 9], direction: '上个月', other: '下个月' },
  { props: { stories: calendar_stories, highlight_id: 2, initial_month: '2026-10' }, months: [10, 11], direction: '下个月', other: '上个月' },
])('opens at the default month and stops at the event bounds ($months)', async ({ props, months, direction, other }) => {
  const calendar = await mountSuspended(Calendar, { props, global: { stubs: { MyIcon: true } } })
  wrappers.push(calendar)
  const move = calendar.get(`button[aria-label="${direction}"]`)
  expect(calendar.get(`button[aria-label="${other}"]`).attributes('disabled')).toBeDefined()
  for (const [index, month] of months.entries()) {
    if (index > 0) {
      expect(move.attributes('disabled')).toBeUndefined()
      await move.trigger('click')
    }
    expect(calendar.text()).toContain(`2026 年 ${month} 月`)
    expect(calendar.find('a[href="/content/4"]').exists()).toBe(false)
  }
  expect(move.attributes('disabled')).toBeDefined()
})
