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
    expect(first.stories.value).toEqual([client_story])
    expect(list_stories).toHaveBeenCalledOnce()
    expect(subscribe).toHaveBeenCalledWith('content_stories:all', expect.any(Function))
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

    const second = useContentStory(ref('7'))
    await second.ready
    expect(second.story.value).toBeNull()
    expect(get_story_body).toHaveBeenCalledTimes(2)
    expect(toast_error).not.toHaveBeenCalled()
  })

  it('keeps a readable story when a refresh fails transiently', async () => {
    const query = useContentStory(ref('7'))
    await query.ready
    const failure = Object.assign(new Error('offline'), { status: 503 })
    get_story_body.mockRejectedValue(failure)

    await listeners.get('content_story:7')!()
    expect(query.story.value?.markdown).toBe('saved')
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
