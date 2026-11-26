import type { ContentStoryBody, ContentStorySummary } from '@shared/types/content'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, isRef, ref, watch } from 'vue'
import { get_error_status } from '~/composables/useApi'
import { useSyncedData } from '~/composables/useSyncedData'
import { useSyncedState } from '~/composables/useSyncedState'
import { useContentStories, useContentStory } from './stories'

const server_story = { id: 1, title: 'server' } as ContentStorySummary
const client_story = { id: 2, title: 'client' } as ContentStorySummary
let app: { isHydrating: boolean, hook: (name: string, callback: () => void) => () => void }
let hooks: Map<string, () => void>
let states: Map<string, ReturnType<typeof ref>>
let unmounts: Array<() => void>
const unsubscribe = vi.fn()
let subscribe: ReturnType<typeof vi.fn>
let list_stories: ReturnType<typeof vi.fn>
let get_story_body: ReturnType<typeof vi.fn>
let listeners: Map<string, () => Promise<void>>
let toast_error: ReturnType<typeof vi.fn>

beforeEach(() => {
  hooks = new Map()
  states = new Map()
  unmounts = []
  unsubscribe.mockReset()
  listeners = new Map()
  subscribe = vi.fn((resource: string, invalidate: () => Promise<void>) => {
    listeners.set(resource, invalidate)
    return () => {
      listeners.delete(resource)
      unsubscribe()
    }
  })
  list_stories = vi.fn(async () => [client_story])
  get_story_body = vi.fn(async id => ({ id, title: `story-${id}`, markdown: 'saved' } as ContentStoryBody))
  toast_error = vi.fn()
  app = {
    isHydrating: false,
    hook: (name, callback) => {
      hooks.set(name, callback)
      return vi.fn()
    },
  }
  for (const [name, value] of Object.entries({ computed, effectScope, get_error_status, isRef, ref, watch }))
    vi.stubGlobal(name, value)
  vi.stubGlobal('onUnmounted', (callback: () => void) => unmounts.push(callback))
  vi.stubGlobal('useNuxtApp', () => app)
  vi.stubGlobal('useReactiveDateNow', () => ref(0))
  vi.stubGlobal('useMyToast', () => ({ error: toast_error }))
  vi.stubGlobal('useDataSync', () => ({ subscribe }))
  vi.stubGlobal('useApi', () => ({ content: { get_story_body, list_stories } }))
  vi.stubGlobal('useState', (key: string, init: () => unknown) => {
    if (! states.has(key))
      states.set(key, ref(init()))
    return states.get(key)!
  })
  vi.stubGlobal('useSyncedState', useSyncedState)
  vi.stubGlobal('useSyncedData', useSyncedData)
})

afterEach(() => {
  unmounts.splice(0).forEach(dispose => dispose())
  vi.unstubAllGlobals()
})

describe('content stories query', () => {
  it('shares one keyed request and payload state between page consumers', async () => {
    const first = useContentStories()
    const second = useContentStories()
    await Promise.all([first.ready, second.ready])

    expect(first.stories).toBe(second.stories)
    expect(first.loading).toBe(second.loading)
    expect(first.error).toBe(second.error)
    expect(first.stories.value).toEqual([client_story])
    expect(list_stories).toHaveBeenCalledOnce()
    expect(subscribe).toHaveBeenCalledWith('content_stories:all', expect.any(Function))
  })

  it('distinguishes loading, a failed source and successful empty data without another query', async () => {
    let reject!: (error: unknown) => void
    list_stories.mockImplementationOnce(() => new Promise((_resolve, no) => reject = no))
    const query = useContentStories()
    const shared = useContentStories()
    await vi.waitFor(() => expect(query.loading.value).toBe(true))
    expect(query.error.value).toBe(false)
    expect(query.stories.value).toBeNull()

    const failure = new Error('offline')
    reject(failure)
    const control = await query.ready
    await shared.ready
    expect(query.loading.value).toBe(false)
    expect(query.error.value).toBe(true)
    expect(shared.error.value).toBe(true)
    expect(toast_error).toHaveBeenCalledExactlyOnceWith(failure)
    expect(list_stories).toHaveBeenCalledOnce()

    list_stories.mockResolvedValueOnce([])
    await control.refresh()
    expect(query.error.value).toBe(false)
    expect(query.stories.value).toEqual([])
    list_stories.mockRejectedValueOnce(failure)
    await control.refresh()
    expect(query.error.value).toBe(true)
    expect(query.stories.value).toEqual([])
  })

  it('keeps the server snapshot until hydration resolves', async () => {
    app.isHydrating = true
    states.set('content_stories', ref([server_story]))
    let resolve_fetch!: (stories: ContentStorySummary[]) => void
    list_stories.mockImplementationOnce(() => new Promise((resolve) => {
      resolve_fetch = resolve
    }))

    const query = useContentStories()
    await query.ready
    resolve_fetch([client_story])
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(query.stories.value).toEqual([server_story])

    app.isHydrating = false
    hooks.get('app:suspense:resolve')!()
    expect(query.stories.value).toEqual([client_story])
  })

  it('releases the shared subscription after its final page consumer exits', async () => {
    const first = useContentStories()
    const second = useContentStories()
    await Promise.all([first.ready, second.ready])
    expect(unmounts).toHaveLength(2)

    unmounts.shift()!()
    expect(unsubscribe).not.toHaveBeenCalled()
    unmounts.shift()!()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('shares a confirmed missing story and does not toast its 404', async () => {
    const first = useContentStory(ref('7'))
    await first.ready
    expect(first.story.value?.markdown).toBe('saved')

    get_story_body.mockRejectedValue({ status: 404 })
    await listeners.get('content_story:7')!()
    expect(first.story.value).toBeNull()
    expect(first.error.value).toBe(false)

    const second = useContentStory(ref('7'))
    await second.ready
    expect(second.story.value).toBeNull()
    expect(get_story_body).toHaveBeenCalledTimes(2)
    expect(toast_error).not.toHaveBeenCalled()
  })

  it('keeps the first-load failure visible during automatic retry and clears it on recovery', async () => {
    const now = ref(100_000)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now.value)
    vi.stubGlobal('useReactiveDateNow', () => now)
    vi.stubGlobal('document', { visibilityState: 'visible' })
    const first = Promise.withResolvers<ContentStoryBody>()
    const retry = Promise.withResolvers<ContentStoryBody>()
    get_story_body.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
    const query = useContentStory(ref('7'))
    const shared = useContentStory(ref('7'))
    expect(query.loading.value).toBe(true)
    expect(query.error.value).toBe(false)

    try {
      const failure = Object.assign(new Error('offline'), { status: 503 })
      first.reject(failure)
      await Promise.all([query.ready, shared.ready])
      expect(query.story.value).toBeNull()
      expect(query.loading.value).toBe(false)
      expect(query.error).toBe(shared.error)
      expect(query.error.value).toBe(true)
      expect(toast_error).toHaveBeenCalledExactlyOnceWith(failure)

      now.value += 60_000
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(get_story_body).toHaveBeenCalledTimes(2)
      expect(query.loading.value).toBe(false)
      expect(query.error.value).toBe(true)

      retry.resolve({ id: 7, markdown: 'recovered' } as ContentStoryBody)
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(query.story.value?.markdown).toBe('recovered')
      expect(query.error.value).toBe(false)
      expect(toast_error).toHaveBeenCalledOnce()
    }
    finally {
      clock.mockRestore()
    }
  })

  it('keeps a readable story when a refresh fails transiently', async () => {
    const query = useContentStory(ref('7'))
    await query.ready
    const failure = Object.assign(new Error('offline'), { status: 503 })
    get_story_body.mockRejectedValue(failure)

    await listeners.get('content_story:7')!()
    expect(query.story.value?.markdown).toBe('saved')
    expect(query.error.value).toBe(true)
    expect(toast_error).toHaveBeenCalledWith(failure)
  })

  it('does not apply a late missing response after switching stories', async () => {
    const story_key = ref('7')
    const query = useContentStory(story_key)
    await query.ready
    let reject!: (error: unknown) => void
    get_story_body.mockReturnValueOnce(new Promise((_resolve, no) => {
      reject = no
    }))
    const pending = listeners.get('content_story:7')!()

    story_key.value = '8'
    await listeners.get('content_story:8')!()
    reject({ status: 404 })
    await pending
    expect(query.story.value?.id).toBe(8)
  })
})
