import type { PermissionGrant } from '@shared/permissions'
import type { AdminUserList } from '@shared/types/user'
import { settings } from '@shared/settings'

export type AdminUserCommand = 'BAN' | 'UNBAN' | 'KICK' | 'VERIFY' | 'UNVERIFY' | 'PROMOTE' | 'DEMOTE'

const fallback_commands = ['BAN', 'UNBAN', 'KICK', 'ALL', 'VERIFY', 'UNVERIFY', 'PROMOTE', 'DEMOTE']
const extra_commands = ['VERIFY', 'UNVERIFY', 'PROMOTE', 'DEMOTE']

/** Paged user list for the admin console, polled for presence-derived fields. */
export function useAdminUsers(query: { page: Ref<number>, page_size: Ref<number>, filter: Ref<string> }, on_data: () => void) {
  const { admin } = useApi()
  const result = useSyncedState<AdminUserList | null>('admin-users-result', () => null)
  const loading = ref(false)
  let refresh: () => Promise<void> = async () => {}
  const ready = useSyncedData<AdminUserList>(
    null,
    () => admin.list_users({ page: query.page.value, page_size: query.page_size.value, filter: query.filter.value || undefined }),
    result,
    loading,
    { universal: false, fetch_without_resource: true, refresh_policy: 'latest', polling_interval: settings.app.admin.pollIntervalSeconds * 1000, on_data },
  ).then((synced) => {
    refresh = synced.refresh
  })

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
    loading,
    ready,
    refresh: () => refresh(),
    run,
    set_permissions: (id: number, grants: PermissionGrant[]) => admin.set_permissions(id, grants),
  }
}

/** Field, keyword and command suggestions for the admin command bar. */
export function useAdminCommandMeta() {
  const { admin } = useApi()
  const fields = ref<string[]>([])
  const sql_keywords = ref<string[]>([])
  const commands = ref<string[]>([])
  const ready = admin.get_keywords().then((meta) => {
    fields.value = meta.fields
    sql_keywords.value = meta.keywords
    commands.value = [... meta.commands, ... extra_commands]
  }, () => {
    commands.value = fallback_commands
  })
  return { fields, sql_keywords, commands, ready }
}
