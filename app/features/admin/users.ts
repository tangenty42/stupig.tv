import type { AdminUserCommand } from '@shared/admin-command'
import type { PermissionGrant } from '@shared/permissions'
import type { AdminUserList } from '@shared/types/user'
import { settings } from '@shared/settings'
import { get_error_status } from '~/composables/useApi'

interface UserListSnapshot {
  result: AdminUserList
  received_at: number
}

/** Paged user list for the admin console, polled for presence-derived fields. */
export function useAdminUsers(query: { page: Ref<number>, page_size: Ref<number>, filter: Ref<string> }, on_data: (value: AdminUserList | null) => void) {
  const { admin } = useApi()
  const { error: notify_error } = useMyToast()
  // Transfer the server's snapshot once. Overlapping client views must never share their results.
  const initial = useSyncedState<UserListSnapshot | null>('admin-users-snapshot', () => null)
  const list = import.meta.server ? initial : useSyncedState(ref(useNuxtApp().isHydrating ? initial.value : null))
  if (import.meta.client) {
    initial.value = null
    onBeforeUnmount(() => {
      list.value = null
    })
  }
  const result = computed(() => list.value?.result ?? null)
  const updated_at = computed(() => list.value ? new Date(list.value.received_at) : null)
  const loading = ref(false)
  const failed = ref(false)
  const access_denied = ref(false)
  const snapshot = () => ({ page: query.page.value, page_size: query.page_size.value, filter: query.filter.value })
  // Applied together so a page and page-size change start one request, not two.
  const params = ref(snapshot())
  let refresh: () => Promise<void> = async () => {}
  const ready = useSyncedData<UserListSnapshot>(
    null,
    async () => {
      const result = await admin.list_users({ page: params.value.page, page_size: params.value.page_size, filter: params.value.filter || undefined })
      // The payload, deferred hydration updates and cached results each keep their original receipt time.
      return { result, received_at: Date.now() }
    },
    list,
    loading,
    {
      share: false,
      fetch_without_resource: true,
      refresh_policy: 'latest',
      query_key: computed(() => `admin-users:${JSON.stringify(params.value)}`),
      polling_interval: settings.app.admin.pollIntervalSeconds * 1000,
      on_data: (value) => {
        failed.value = false
        on_data(value?.result ?? null)
      },
      on_error: (error) => {
        failed.value = true
        const status = get_error_status(error)
        if (status === 401 || status === 403) {
          discard_list()
          access_denied.value = true
        }
        else {
          notify_error(error)
        }
      },
    },
  ).then((synced) => {
    refresh = synced.refresh
  })

  function discard_list() {
    list.value = null
    on_data(null)
  }

  /** Load the current page and filter; a changed query replaces the list, an unchanged one is refreshed. */
  function reload() {
    const next = snapshot()
    if (JSON.stringify(next) !== JSON.stringify(params.value)) {
      discard_list()
      failed.value = false
      params.value = next
      return Promise.resolve()
    }
    return refresh()
  }

  async function run(command: AdminUserCommand, id: number, verified_note?: string | null) {
    switch (command) {
      case 'BAN': return admin.set_banned(id, true)
      case 'UNBAN': return admin.set_banned(id, false)
      case 'KICK': return admin.force_logout(id)
      case 'VERIFY': return admin.set_verification(id, true, verified_note)
      case 'UNVERIFY': return admin.set_verification(id, false)
      case 'PROMOTE': return admin.set_admin_role(id, true)
      case 'DEMOTE': return admin.set_admin_role(id, false)
    }
  }

  return {
    result,
    updated_at,
    loading,
    failed,
    access_denied,
    ready,
    refresh: reload,
    run,
    set_permissions: (id: number, grants: PermissionGrant[]) => admin.set_permissions(id, grants),
  }
}
