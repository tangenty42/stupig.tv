import type { Ref } from 'vue'
import { isRef } from 'vue'

declare const synced_state_brand: unique symbol

export type SyncedState<T> = Ref<T> & {
  readonly [synced_state_brand]: true
}

const synced_state_refs = new WeakSet<object>()

export function useSyncedState<T>(key: string, init: () => T): SyncedState<T>
export function useSyncedState<T>(state: Ref<T>): SyncedState<T>
export function useSyncedState<T>(key_or_state: string | Ref<T>, init?: () => T): SyncedState<T> {
  const state = isRef(key_or_state)
    ? key_or_state
    : useState<T>(key_or_state, init!)

  synced_state_refs.add(state)
  return state as SyncedState<T>
}

export function is_synced_state(state: unknown): state is SyncedState<unknown> {
  return isRef(state) && synced_state_refs.has(state)
}
