import type { ContentDraftSummary } from '@shared/types/content-draft'
import type { InjectionKey } from 'vue'
import { inject, ref } from 'vue'

interface DraftList {
  items: ContentDraftSummary[]
}

export function create_draft_scene(refresh: () => Promise<void>) {
  return {
    data: ref<DraftList | null>(null),
    error: ref<Error | null>(null),
    loading: ref(false),
    refresh,
    ready: Promise.resolve({ refresh }),
  }
}

export const draft_scene_key: InjectionKey<ReturnType<typeof create_draft_scene>> = Symbol('draft list scene')

export function useContentDraftList() {
  return inject(draft_scene_key)!
}
