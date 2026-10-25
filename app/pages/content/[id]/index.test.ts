import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, effectScope, isRef, ref, watch } from 'vue'
import { get_error_status } from '~/composables/useApi'
import { useSyncedData } from '~/composables/useSyncedData'
import { read_content_resource } from '~/utils/content/read-resource'

// Execute the page's real subscription wiring; testing only the reader would
// miss a caller that still passes its throwing fetcher directly to the query.
const source = readFileSync(new URL('./index.vue', import.meta.url), 'utf8')
const subscription = source.slice(source.indexOf('await useSyncedData<ContentStoryBody'), source.indexOf('\nconst stories ='))
const fetcher = vi.fn<(id: number) => Promise<{ id: number, markdown: string }>>()
const listeners = new Map<string, () => Promise<void>>()
const disposers: (() => void)[] = []
const toast = vi.fn()

beforeEach(() => {
  const app = { isHydrating: false }
  fetcher.mockReset().mockImplementation(async id => ({ id, markdown: 'saved' }))
  toast.mockReset()
  listeners.clear()
  for (const [name, value] of Object.entries({ effectScope, isRef, ref, watch, get_error_status }))
    vi.stubGlobal(name, value)
  vi.stubGlobal('onUnmounted', (fn: () => void) => disposers.push(fn))
  vi.stubGlobal('useNuxtApp', () => app)
  vi.stubGlobal('useMyToast', () => ({ error: toast }))
  vi.stubGlobal('useDataSync', () => ({ subscribe: (key: string, callback: () => Promise<void>) => {
    listeners.set(key, callback)
    return () => listeners.delete(key)
  } }))
})

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  vi.unstubAllGlobals()
})

async function open(id = ref(7)) {
  const story = ref<{ id: number, markdown: string } | null>(null)
  await runInNewContext(ts.transpile(`(async () => {${subscription}})()`), {
    computed, useSyncedData, read_content_resource, story, story_id: id,
    loading: ref(false), content: { get_story_body: fetcher }, sync_resource: (type: string, value: number) => `${type}:${value}`,
  })
  return { story, id }
}

it('replaces a deleted detail and its shared cached value with the existing empty state', async () => {
  const one = await open()
  expect(one.story.value?.markdown).toBe('saved')
  fetcher.mockRejectedValue({ data: { httpStatus: 404 } })
  await listeners.get('content_story:7')!()
  expect(one.story.value).toBeNull()
  const two = await open()
  expect(two.story.value).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(toast).not.toHaveBeenCalled()
})

it('keeps a readable detail on transient failure', async () => {
  const { story } = await open()
  const error = Object.assign(new Error('offline'), { status: 503 })
  fetcher.mockRejectedValue(error)
  await listeners.get('content_story:7')!()
  expect(story.value?.markdown).toBe('saved')
  expect(toast).toHaveBeenCalledWith(error)
})

it('does not apply a late missing response to a different story', async () => {
  const { story, id } = await open()
  let reject!: (error: unknown) => void
  fetcher.mockReturnValueOnce(new Promise((_resolve, no) => {
    reject = no
  }))
  const pending = listeners.get('content_story:7')!()
  id.value = 8
  await listeners.get('content_story:8')!()
  reject({ status: 404 })
  await pending
  expect(story.value).toEqual({ id: 8, markdown: 'saved' })
})
