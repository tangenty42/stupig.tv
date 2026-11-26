<template>
  <div class="space-y-8 sm:space-y-12">
    <slot name="header" :updated_at="updated_at" />
    <MyAdminSectionCard title="命令">
      <MyAdminCmdBar
        :selected_ids="selected_ids"
        :can_manage="can_manage"
        @execute-filter="apply_filter"
        @execute-command="handle_command"
      />
    </MyAdminSectionCard>

    <MyAdminSectionCard title="用户列表">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <MyBadge outlined :type="active_filter ? 'warning' : 'info'" class="max-w-full gap-2">
          <span class="min-w-0 [overflow-wrap:anywhere]">
            <span class="font-medium">筛选条件</span>
            <span class="ms-2 font-mono">{{ active_filter || '全部用户，按 UID 倒序' }}</span>
          </span>
          <Button
            v-if="active_filter"
            severity="secondary"
            variant="text"
            class="shrink-0 !p-0.5"
            aria-label="清除筛选条件"
            @click="clear_filter"
          >
            <MyIcon name="lucide:x" class="text-sm" />
          </Button>
        </MyBadge>
        <div class="flex flex-wrap items-center gap-2">
          <Transition name="cancel-select">
            <Button v-if="selected_count" :label="`取消选择（${selected_count}）`" size="small" @click="clear_selection">
              <template #icon>
                <MyIcon name="lucide:x" />
              </template>
            </Button>
          </Transition>
          <Button
            severity="secondary" outlined :disabled="users_loading" label="刷新" size="small"
            class="whitespace-nowrap !border-slate-300 !font-medium !text-slate-700 dark:!border-slate-600 dark:!text-slate-300" @click="reload_users()"
          >
            <template #icon>
              <MyIcon name="lucide:refresh-cw" />
            </template>
          </Button>
        </div>
      </div>

      <div v-if="can_manage" role="group" aria-label="批量操作" class="mt-4">
        <div class="flex flex-wrap gap-2">
          <Button
            :variant="current_page_all_selected ? undefined : 'text'"
            :label="current_page_all_selected ? '取消选择本页' : '全选本页'"
            :disabled="! users.length"
            size="small"
            @click="toggle_current_page_selection"
          >
            <template #icon>
              <MyIcon name="lucide:check-check" />
            </template>
          </Button>
          <Button
            v-for="shortcut in shortcut_commands"
            :key="shortcut.key"
            :severity="shortcut.severity"
            text
            :loading="batch_pending_command === shortcut.key"
            :disabled="! selected_count || batch_busy"
            :label="shortcut.label"
            size="small"
            @click="handle_command(shortcut.key)"
          >
            <template #icon>
              <MyIcon :name="shortcut.icon" />
            </template>
          </Button>
        </div>
      </div>

      <Paginator
        aria-label="用户列表分页"
        class="mt-3"
        :first="first_record_index"
        :rows="page_size"
        :total-records="total"
        :rows-per-page-options="rows_per_page_options"
        :pt="{ content: { class: 'min-w-0 flex-wrap justify-center' }, pages: { class: 'flex-wrap' } }"
        template="CurrentPageReport PrevPageLink PageLinks NextPageLink RowsPerPageDropdown"
        current-page-report-template="{first} ~ {last} / {totalRecords}"
        @page="change_page"
      />

      <p v-if="! users_loading && ! users.length" role="status" class="mt-3 text-center text-sm text-slate-600 dark:text-slate-400">
        <MyIcon name="lucide:search-x" class="me-1" />{{ users_query.failed.value ? '用户列表读取失败' : '没有匹配的用户' }}
      </p>

      <template #after>
        <MyHeightTransition>
          <div v-if="users_loading && ! users.length" class="mt-4 grid gap-4 md:grid-cols-2">
            <div v-for="index in 4" :key="index" class="admin-skeleton-card" />
          </div>
          <div v-else-if="users.length" role="list" aria-label="用户卡片" class="user-card-grid mt-4 columns-1 gap-4 pb-3 md:columns-2">
            <MyAdminUserCard
              v-for="user in users"
              :key="user.id"
              role="listitem"
              :user="user"
              :selected="selected_ids.has(user.id)"
              :disable_pending="pending_disable_user_ids.has(user.id)"
              :logout_pending="pending_logout_user_ids.has(user.id)"
              :can_manage="can_manage"
              @toggle-disabled="toggle_disabled"
              @force-logout="force_logout"
              @toggle-verified="toggle_verified"
              @toggle-admin="toggle_admin"
              @edit-permissions="open_permission_dialog"
              @toggle-select="toggle_selection"
            />
          </div>
        </MyHeightTransition>
      </template>
    </MyAdminSectionCard>

    <MyDialog
      :visible="verify_note_dialog_visible"
      header="认证说明"
      :pending="verify_dialog_pending"
      :closable="! verify_dialog_pending"
      @update:visible="! $event && reset_verify_note_dialog()"
    >
      <div>
        <div v-if="verify_target_ids.length" class="mb-3 text-sm text-slate-500 dark:text-slate-400">
          <template v-if="verify_target_ids.length > 1">
            为<MyBadge outlined type="info" class="mx-1 max-w-full [overflow-wrap:anywhere]">
              {{ verify_first_username || `#${verify_target_ids[0]}` }}
            </MyBadge>等，共 {{ verify_target_ids.length }} 名用户
          </template>
          <template v-else>
            {{ verify_first_username ? `用户『${verify_first_username}』` : `用户#${verify_target_ids[0]}` }}
          </template>
        </div>
        <Textarea
          v-model="verify_note_value"
          auto-resize
          fluid
          rows="4"
          maxlength="255"
          placeholder="是怎么样的蠢猪？"
        />
        <div class="w-full text-end text-xs text-slate-500 dark:text-slate-400">
          {{ verify_note_value.trim().length }} / 255
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <Button
            v-if="verify_remove_available"
            label="移除认证"
            severity="danger"
            text
            :loading="verify_remove_pending"
            :disabled="verify_dialog_pending"
            @click="remove_verification"
          >
            <template #icon>
              <MyIcon name="lucide:check" />
            </template>
          </Button>
          <Button label="保存" :loading="verify_note_pending" :disabled="verify_dialog_pending" @click="submit_verification_note">
            <template #icon>
              <MyIcon name="lucide:check" />
            </template>
          </Button>
        </div>
      </template>
    </MyDialog>

    <MyDialog
      v-model:visible="permission_dialog_visible"
      header="修改权限"
      :pending="permission_pending"
      :closable="! permission_pending"
    >
      <div v-if="permission_target" class="space-y-5">
        <div class="text-sm text-slate-500 dark:text-slate-400">
          用户<MyBadge outlined type="info" class="mx-1 max-w-full [overflow-wrap:anywhere]">
            {{ permission_target.username || `#${permission_target.id}` }}
          </MyBadge>
        </div>

        <div v-for="item in permission_options" :key="item.field" class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="font-medium text-slate-900 dark:text-slate-100">
              {{ item.name }}
            </div>
            <div class="text-xs text-slate-500 dark:text-slate-400">
              {{ permission_description(item) }}
            </div>
          </div>
          <SelectButton
            v-model="permission_draft[item.field]"
            class="shrink-0"
            :options="item.options"
            option-label="label"
            option-value="value"
            :allow-empty="false"
          />
        </div>
      </div>

      <template #footer>
        <Button label="保存" :loading="permission_pending" :disabled="permission_pending" @click="submit_permissions">
          <template #icon>
            <MyIcon name="lucide:check" />
          </template>
        </Button>
      </template>
    </MyDialog>
  </div>
</template>

<script setup lang="ts">
import type { AdminCommand, AdminUserCommand as BatchCommand } from '@shared/admin-command'
import type { PermissionField, PermissionGrant, PermissionLevel } from '@shared/permissions'
import type { AdminUser } from '@shared/types/user'
import { has_permission, is_valid_permission_grant, PERMISSIONS } from '@shared/permissions'
import { get_error_status } from '~/composables/useApi'
import { TrpcApiError } from '~/composables/useTrpcClient'
import { useAdminUsers } from '~/features/admin/users'
import { error_message } from '~/utils/error'

const emit = defineEmits<{ 'access-denied': [] }>()

const rows_per_page_options = [10, 50, 100, 154800]

const shortcut_commands = [
  { key: 'BAN', label: '封禁', severity: 'danger', icon: 'lucide:ban' },
  { key: 'UNBAN', label: '解封', severity: 'success', icon: 'lucide:circle-check' },
  { key: 'KICK', label: '强制下线', severity: 'secondary', icon: 'lucide:log-out' },
  { key: 'VERIFY', label: '授予认证', severity: 'success', icon: 'lucide:badge-check' },
  { key: 'UNVERIFY', label: '移除认证', severity: 'secondary', icon: 'lucide:badge-x' },
  { key: 'PROMOTE', label: '设为管理员', severity: 'warn', icon: 'lucide:shield-check' },
  { key: 'DEMOTE', label: '撤销管理员身份', severity: 'secondary', icon: 'lucide:shield-off' },
] as const satisfies ReadonlyArray<{ key: BatchCommand, label: string, severity: string, icon: string }>

const { ok, error, grouped_error } = useMyToast()
const { user: auth_user } = useAuth()

// admin_access 只读用户可进入后台查看，但所有写操作入口隐藏；完全级别为管理员特有
const can_manage = computed(() => has_permission(auth_user.value, 'admin_access', 'full'))

// SelectButton 不会高亮 null 值选项，用 'none' 哨兵表示未授予；管理员特有的级别不出现在选项里
const permission_options = PERMISSIONS.map(item => ({
  ... item,
  options: [
    { label: '未授予', value: 'none' },
    ... item.levels.filter(level => is_valid_permission_grant(item.field, level.level)).map(level => ({ label: level.name, value: level.level })),
  ],
}))

const active_filter = ref('')
const page = ref(1)
const page_size = ref(rows_per_page_options[0]!)

const selected_ids = ref(new Set<number>())
const users_query = useAdminUsers({ page, page_size, filter: active_filter }, (result) => {
  if (result)
    prune_selection(result.users)
  else
    reset_management()
})
const { result: users_result, loading: users_loading, updated_at } = users_query

const pending_disable_user_ids = ref(new Set<number>())
const pending_logout_user_ids = ref(new Set<number>())
const batch_pending_command = ref<BatchCommand | null>(null)

const verify_note_dialog_visible = ref(false)
const verify_note_value = ref('')
const verify_target_ids = ref<number[]>([])
const verify_remove_pending = ref(false)

const permission_dialog_visible = ref(false)
const permission_target = ref<AdminUser | null>(null)
const permission_draft = ref<Partial<Record<PermissionField, PermissionLevel | 'none'>>>({})
const permission_pending = ref(false)

const users = computed<AdminUser[]>(() => users_result.value?.users ?? [])
const total = computed(() => users_result.value?.total ?? 0)
const selected_count = computed(() => selected_ids.value.size)
const first_record_index = computed(() => Math.max(0, (page.value - 1) * page_size.value))
const current_page_all_selected = computed(() => {
  return users.value.length > 0 && users.value.every((user: AdminUser) => selected_ids.value.has(user.id))
})
const batch_busy = computed(() => batch_pending_command.value !== null)
const verify_note_pending = computed(() => batch_pending_command.value === 'VERIFY')
const verify_dialog_pending = computed(() => verify_note_pending.value || verify_remove_pending.value)
const verify_first_username = computed(() => users.value.find(user => user.id === verify_target_ids.value[0])?.username)
const verify_remove_available = computed(() => {
  return verify_target_ids.value.length === 1
    && Boolean(users.value.find(user => user.id === verify_target_ids.value[0])?.is_verified)
})

// Changing the result set or losing write access invalidates any targets a dialog or batch captured.
let management_revision = 0
let view_active = true
function reset_management() {
  management_revision ++
  clear_selection()
  verify_note_dialog_visible.value = false
  verify_note_value.value = ''
  verify_target_ids.value = []
  permission_dialog_visible.value = false
  permission_target.value = null
  permission_draft.value = {}
}

watch(can_manage, (allowed) => {
  if (! allowed)
    reset_management()
}, { flush: 'sync' })
watch(users_query.access_denied, (denied) => {
  if (denied)
    emit('access-denied')
})
onBeforeUnmount(() => {
  view_active = false
  reset_management()
})

function next_set_with(ids: Set<number>, target_id: number, enabled: boolean) {
  const next = new Set(ids)
  if (enabled) {
    next.add(target_id)
  }
  else {
    next.delete(target_id)
  }
  return next
}

function add_pending(set_ref: Ref<Set<number>>, ids: number[]) {
  const next = new Set(set_ref.value)
  ids.forEach(id => next.add(id))
  set_ref.value = next
}

function remove_pending(set_ref: Ref<Set<number>>, ids: number[]) {
  const next = new Set(set_ref.value)
  ids.forEach(id => next.delete(id))
  set_ref.value = next
}

function prune_selection(visible_users: AdminUser[]) {
  const visible_ids = new Set(visible_users.map(user => user.id))
  selected_ids.value = new Set(Array.from(selected_ids.value).filter(id => visible_ids.has(id)))
}

function clear_selection() {
  selected_ids.value = new Set()
}

function toggle_selection(id: number) {
  selected_ids.value = next_set_with(selected_ids.value, id, ! selected_ids.value.has(id))
}

function toggle_current_page_selection() {
  if (! users.value.length) {
    return
  }

  const should_select = ! current_page_all_selected.value
  const next = new Set(selected_ids.value)
  for (const user of users.value) {
    if (should_select) {
      next.add(user.id)
    }
    else {
      next.delete(user.id)
    }
  }
  selected_ids.value = next
}

await users_query.ready

function reload_users() {
  return users_query.refresh()
}

function apply_filter(filter: string) {
  active_filter.value = filter.trim()
  page.value = 1
  void reload_users()
}

function clear_filter() {
  active_filter.value = ''
  page.value = 1
  void reload_users()
}

function change_page(event: { first: number, rows: number }) {
  page.value = Math.floor(event.first / event.rows) + 1
  page_size.value = event.rows
  void reload_users()
}

function permission_description(item: (typeof permission_options)[number]) {
  const level = permission_draft.value[item.field]
  const definition = level && level !== 'none'
    ? item.levels.find(candidate => candidate.level === level)
    : null
  return definition?.description ?? item.description
}

async function perform_command(command: BatchCommand, ids: number[], verified_note?: string | null) {
  if (! ids.length || ! can_manage.value || batch_busy.value) {
    return false
  }

  if (command === 'BAN' || command === 'UNBAN') {
    add_pending(pending_disable_user_ids, ids)
  }
  if (command === 'KICK') {
    add_pending(pending_logout_user_ids, ids)
  }
  batch_pending_command.value = command

  const success_map: Record<BatchCommand, string> = {
    BAN: '封禁',
    UNBAN: '解封',
    KICK: '强制下线',
    VERIFY: '授予认证',
    UNVERIFY: '移除认证',
    PROMOTE: '设为管理员',
    DEMOTE: '撤销管理员身份',
  }

  const revision = management_revision
  const actor_id = auth_user.value?.id
  const current = () => view_active && can_manage.value && revision === management_revision && actor_id === auth_user.value?.id
  const usernames = new Map(users.value.map(user => [user.id, user.username]))
  const targets = ids.map(id => ({ id, username: usernames.get(id) || `#${id}` }))
  const username = targets[0]!.username
  const rejected = new Map<string, { username: string, count: number }>()
  let stopped: { error: unknown } | undefined
  try {
    for (const target of targets) {
      if (! current())
        return false
      try {
        await users_query.run(command, target.id, verified_note)
      }
      catch (ex) {
        const status = get_error_status(ex)
        if (! current() || status === 401)
          return false
        // Only an explicit pre-write rejection allows the next target to run.
        if (ids.length > 1 && ex instanceof TrpcApiError && ex.code === 'ADMIN_TARGET_REJECTED' && (status === 400 || status === 404)) {
          const message = error_message(ex)
          const prefix = [`${target.username}：`, `${target.username}:`].find(value => message.startsWith(value))
          const reason = prefix ? message.slice(prefix.length).trimStart() : message
          const group = rejected.get(reason)
          if (group)
            group.count ++
          else
            rejected.set(reason, { username: target.username, count: 1 })
        }
        else {
          stopped = { error: ex }
          break
        }
      }
    }

    if (! current())
      return false
    if (rejected.size) {
      grouped_error(Array.from(rejected, ([reason, group]) => ({
        before: '',
        badge: group.username,
        after: `${group.count > 1 ? `等 ${group.count} 个用户` : ''}：${reason}`,
      })))
    }
    if (stopped)
      error(stopped.error)
    if (rejected.size || stopped) {
      await reload_users()
      return false
    }

    ok({ before: `${success_map[command]}：`, badge: username, after: ids.length > 1 ? `等，共 ${ids.length} 名用户` : '' })
    clear_selection()
    await reload_users()
    return true
  }
  catch (ex) {
    if (! current() || get_error_status(ex) === 401)
      return false
    error(ex)
    return false
  }
  finally {
    if (command === 'BAN' || command === 'UNBAN') {
      remove_pending(pending_disable_user_ids, ids)
    }
    if (command === 'KICK') {
      remove_pending(pending_logout_user_ids, ids)
    }
    batch_pending_command.value = null
  }
}

function reset_verify_note_dialog() {
  if (verify_dialog_pending.value) {
    return
  }
  verify_note_dialog_visible.value = false
  verify_note_value.value = ''
  verify_target_ids.value = []
}

function request_verification_note(ids: number[]) {
  if (! ids.length || ! can_manage.value) {
    return
  }

  verify_target_ids.value = [... ids]
  verify_note_value.value = ids.length === 1
    ? (users.value.find(user => user.id === ids[0])?.verified_note ?? '')
    : ''
  verify_note_dialog_visible.value = true
}

async function submit_verification_note() {
  const note = verify_note_value.value.trim()
  if (! note) {
    error('请填写认证说明')
    return
  }

  const ids = [... verify_target_ids.value]
  const success = await perform_command('VERIFY', ids, note)
  if (success) {
    reset_verify_note_dialog()
  }
}

async function remove_verification() {
  const ids = [... verify_target_ids.value]
  if (! ids.length || verify_remove_pending.value) {
    return
  }

  verify_remove_pending.value = true
  const success = await perform_command('UNVERIFY', ids)
  verify_remove_pending.value = false
  if (success) {
    reset_verify_note_dialog()
  }
}

function handle_command(command: AdminCommand | '') {
  if (! command) {
    clear_filter()
    return
  }

  if (! can_manage.value) {
    return
  }

  if (command === 'ALL') {
    toggle_current_page_selection()
    return
  }

  const ids = Array.from((selected_ids.value as Set<number>).values())
  if (! ids.length) {
    return
  }

  if (command === 'VERIFY') {
    request_verification_note(ids)
    return
  }

  void perform_command(command, ids)
}

function toggle_disabled(user: AdminUser) {
  void perform_command(user.is_banned ? 'UNBAN' : 'BAN', [user.id])
}

function force_logout(user: AdminUser) {
  void perform_command('KICK', [user.id])
}

function toggle_verified(user: AdminUser) {
  request_verification_note([user.id])
}

function toggle_admin(user: AdminUser) {
  void perform_command(user.is_admin ? 'DEMOTE' : 'PROMOTE', [user.id])
}

function open_permission_dialog(user: AdminUser) {
  if (user.is_admin || ! can_manage.value) {
    return
  }

  permission_target.value = user

  const draft: Partial<Record<PermissionField, PermissionLevel | 'none'>> = {}
  for (const item of PERMISSIONS) {
    draft[item.field] = 'none'
  }
  for (const grant of user.permissions) {
    draft[grant.field] = grant.level
  }
  permission_draft.value = draft
  permission_dialog_visible.value = true
}

async function submit_permissions() {
  const target = permission_target.value
  if (! target || ! can_manage.value || permission_pending.value) {
    return
  }

  const grants: PermissionGrant[] = []
  for (const item of PERMISSIONS) {
    const level = permission_draft.value[item.field]
    if (level && level !== 'none') {
      grants.push({ field: item.field, level })
    }
  }

  const revision = management_revision
  permission_pending.value = true
  try {
    await users_query.set_permissions(target.id, grants)
    if (revision !== management_revision)
      return
    ok({ before: '已更新', badge: target.username || `#${target.id}`, after: '的权限' })
    permission_dialog_visible.value = false
    await reload_users()
  }
  catch (ex) {
    error(ex)
  }
  finally {
    permission_pending.value = false
  }
}
</script>

<style scoped>
  .admin-skeleton-card {
    @apply h-56 rounded-[1.5rem] border border-slate-200/80 bg-gradient-to-br from-white via-slate-50 to-slate-100 dark:border-slate-700 dark:from-slate-900 dark:via-slate-900 dark:to-slate-800;
    animation: admin-pulse 1.4s ease-in-out infinite;
  }

  .user-card-grid :deep(> *) {
    @apply mb-4 last:mb-0;
  }

  /* Opacity only: any transform or margin would fight the row's flex layout
     and the label's own width changes while the count updates. */
  .cancel-select-enter-active,
  .cancel-select-leave-active {
    transition: opacity 0.15s ease;
  }

  .cancel-select-enter-from,
  .cancel-select-leave-to {
    opacity: 0;
  }

  @keyframes admin-pulse {
    0%, 100% {
      opacity: 0.72;
      transform: scale(1);
    }

    50% {
      opacity: 1;
      transform: scale(0.992);
    }
  }
</style>
