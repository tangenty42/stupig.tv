<template>
  <div class="space-y-12 pb-12 pt-8">
    <MyHeightSection tag="section" class="section-card-collapse">
      <div class="mb-4">
        <MyAdminCmdBar
          :selected_ids="selected_ids"
          placeholder="请输入约束 / 命令"
          @execute-filter="apply_filter"
          @execute-command="handle_command"
          @clear-selection="clear_selection"
        />
        <MyBadge outlined :type="active_filter ? 'warning' : 'info'" class="mt-2 inline-flex flex-wrap items-center gap-2">
          <span class="font-medium">当前约束</span>
          <span class="font-mono text-xs">{{ active_filter || '空，按 UID 倒序' }}</span>
          <Button
            v-if="active_filter"
            severity="secondary"
            variant="text"
            class="!p-1"
            aria-label="清空约束"
            @click="clear_filter"
          >
            <MyIcon name="lucide:x" class="text-base" />
          </Button>
        </MyBadge>
      </div>
    </MyHeightSection>

    <MyHeightSection tag="section" class="section-card-collapse">
      <div class="mb-6 flex gap-3 items-center justify-between">
        <h2>用户列表</h2>

        <div class="flex flex-wrap gap-2">
          <Button v-if="selected_count" severity="secondary" text label="清空已选" size="small" @click="clear_selection">
            <template #icon>
              <MyIcon name="lucide:trash-2" />
            </template>
          </Button>
          <Button severity="secondary" text :loading="users_loading" label="刷新" size="small" @click="reload_users('manual')">
            <template #icon>
              <MyIcon name="lucide:refresh-cw" />
            </template>
          </Button>
        </div>
      </div>

      <div class="mb-2 flex flex-wrap gap-2">
        <Button
          :variant="current_page_all_selected ? undefined : 'text'"
          :label="current_page_all_selected ? '取消全选' : '全选本页'"
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
          :disabled="batch_busy"
          :label="shortcut.label"
          size="small"
          @click="handle_command(shortcut.key)"
        >
          <template #icon>
            <MyIcon :name="shortcut.icon" />
          </template>
        </Button>
      </div>

      <Paginator
        :first="first_record_index"
        :rows="page_size"
        :total-records="total"
        :rows-per-page-options="rows_per_page_options"
        template="CurrentPageReport PrevPageLink PageLinks NextPageLink RowsPerPageDropdown"
        current-page-report-template="{first} ~ {last} / {totalRecords}"
        @page="change_page"
      />

      <div v-if="users_loading && ! users.length" class="mt-6 grid gap-4 md:grid-cols-2">
        <div v-for="index in 4" :key="index" class="admin-skeleton-card" />
      </div>

      <div v-else-if="users.length" class="user-card-grid mt-6 pb-3 columns-1 gap-4 md:columns-2">
        <KeepAlive>
          <MyAdminUserCard
            v-for="user in users"
            :key="user.id"
            :user="user"
            :selected="selected_ids.has(user.id)"
            :disable_pending="pending_disable_user_ids.has(user.id)"
            :logout_pending="pending_logout_user_ids.has(user.id)"
            @toggle-disabled="toggle_disabled"
            @force-logout="force_logout"
            @toggle-verified="toggle_verified"
            @toggle-admin="toggle_admin"
            @toggle-select="toggle_selection"
          />
        </KeepAlive>
      </div>

      <div v-else class="mt-6 rounded-md border border-dashed border-slate-300 bg-slate-50/80 px-6 py-12 text-center dark:border-slate-700 dark:bg-slate-900/40">
        <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-white text-slate-500 shadow-sm dark:bg-slate-800 dark:text-slate-300">
          <MyIcon name="lucide:search-x" class="text-2xl" />
        </div>
        <h3 class="mt-4 text-lg font-semibold text-slate-900 dark:text-white">
          没有匹配的用户
        </h3>
      </div>
    </MyHeightSection>

    <MyDialog
      v-model:visible="verify_note_dialog_visible"
      header="认证说明"
      :pending="verify_note_pending"
      :closable="! verify_note_pending"
    >
      <div>
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
          <Button label="取消" severity="secondary" text :disabled="verify_note_pending" @click="reset_verify_note_dialog" />
          <Button label="授予" :loading="verify_note_pending" :disabled="verify_note_pending" @click="submit_verification_note">
            <template #icon>
              <MyIcon name="lucide:badge-check" />
            </template>
          </Button>
        </div>
      </template>
    </MyDialog>
  </div>
</template>

<script setup lang="ts">
import type { AdminUser, AdminUserList } from '@shared/types/user'

definePageMeta({
  middleware: 'require-admin-auth',
})

useSeoMeta({ robots: 'noindex, nofollow' })

type RefreshReason = 'initial' | 'query' | 'manual' | 'polling' | 'mutation'
type BatchCommand = 'BAN' | 'UNBAN' | 'KICK' | 'VERIFY' | 'UNVERIFY' | 'PROMOTE' | 'DEMOTE'

const rows_per_page_options = [10, 50, 100, 154800]
const runtime_config = useRuntimeConfig()
const poll_interval_seconds = runtime_config.public.poll_interval_seconds
const poll_interval_ms = poll_interval_seconds * 1000

const shortcut_commands = [
  { key: 'BAN', label: '封禁', severity: 'danger', icon: 'lucide:ban' },
  { key: 'UNBAN', label: '解封', severity: 'success', icon: 'lucide:circle-check' },
  { key: 'KICK', label: '强制下线', severity: 'secondary', icon: 'lucide:log-out' },
  { key: 'VERIFY', label: '授予认证', severity: 'success', icon: 'lucide:badge-check' },
  { key: 'UNVERIFY', label: '移除认证', severity: 'secondary', icon: 'lucide:badge-x' },
  { key: 'PROMOTE', label: '设为管理员', severity: 'warn', icon: 'lucide:shield-check' },
  { key: 'DEMOTE', label: '撤销管理员', severity: 'secondary', icon: 'lucide:shield-off' },
] as const satisfies ReadonlyArray<{ key: BatchCommand, label: string, severity: string, icon: string }>

const { admin } = useApi()
const { ok, error } = useMyToast()

const active_filter = ref('')
const page = ref(1)
const page_size = ref(rows_per_page_options[0]!)

const users_result = ref<AdminUserList | null>(null)
const users_loading = ref(false)
const selected_ids = ref(new Set<number>())

const pending_disable_user_ids = ref(new Set<number>())
const pending_logout_user_ids = ref(new Set<number>())
const batch_pending_command = ref<BatchCommand | null>(null)

const verify_note_dialog_visible = ref(false)
const verify_note_value = ref('')
const verify_target_ids = ref<number[]>([])

const last_sync_at = ref<number | null>(null)
const last_sync_reason = ref<RefreshReason>('initial')

let poll_timer: ReturnType<typeof setInterval> | null = null
let reload_serial = 0

const users = computed<AdminUser[]>(() => users_result.value?.users ?? [])
const total = computed(() => users_result.value?.total ?? 0)
const selected_count = computed(() => selected_ids.value.size)
const first_record_index = computed(() => Math.max(0, (page.value - 1) * page_size.value))
const current_page_all_selected = computed(() => {
  return users.value.length > 0 && users.value.every((user: AdminUser) => selected_ids.value.has(user.id))
})
const batch_busy = computed(() => batch_pending_command.value !== null)
const verify_note_pending = computed(() => batch_pending_command.value === 'VERIFY')

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

function prune_selection() {
  const visible_ids = new Set(users.value.map((user: AdminUser) => user.id))
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

async function reload_users(reason: RefreshReason) {
  const serial = ++ reload_serial
  users_loading.value = true

  try {
    const result = await admin.list_users({
      page: page.value,
      page_size: page_size.value,
      filter: active_filter.value || undefined,
    })

    if (serial !== reload_serial) {
      return
    }

    users_result.value = result
    last_sync_reason.value = reason
    last_sync_at.value = Date.now()
    prune_selection()
  }
  catch (ex) {
    if (serial === reload_serial) {
      error(ex)
    }
  }
  finally {
    if (serial === reload_serial) {
      users_loading.value = false
    }
  }
}

function apply_filter(filter: string) {
  active_filter.value = filter.trim()
  page.value = 1
  void reload_users('query')
}

function clear_filter() {
  active_filter.value = ''
  page.value = 1
  void reload_users('query')
}

function change_page(event: { first: number, rows: number }) {
  page.value = Math.floor(event.first / event.rows) + 1
  page_size.value = event.rows
  void reload_users('query')
}

async function perform_command(command: BatchCommand, ids: number[], verified_note?: string | null) {
  if (! ids.length) {
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
    PROMOTE: '授予管理员身份',
    DEMOTE: '撤销管理员身份',
  }

  try {
    for (const id of ids) {
      if (command === 'BAN') {
        await admin.set_banned(id, true)
      }
      else if (command === 'UNBAN') {
        await admin.set_banned(id, false)
      }
      else if (command === 'KICK') {
        await admin.force_logout(id)
      }
      else if (command === 'VERIFY') {
        await admin.set_verification(id, true, verified_note)
      }
      else if (command === 'UNVERIFY') {
        await admin.set_verification(id, false)
      }
      else if (command === 'PROMOTE') {
        await admin.set_admin_role(id, true)
      }
      else if (command === 'DEMOTE') {
        await admin.set_admin_role(id, false)
      }
    }

    ok(`${success_map[command]} ${ids.length} 个用户`)
    clear_selection()
    await reload_users('mutation')
    return true
  }
  catch (ex) {
    error(ex)
    await reload_users('mutation')
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
  if (verify_note_pending.value) {
    return
  }
  verify_note_dialog_visible.value = false
  verify_note_value.value = ''
  verify_target_ids.value = []
}

function request_verification_note(ids: number[]) {
  if (! ids.length) {
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

function handle_command(command: string) {
  if (! command) {
    clear_filter()
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

  void perform_command(command as BatchCommand, ids)
}

function toggle_disabled(user: AdminUser) {
  void perform_command(user.is_banned ? 'UNBAN' : 'BAN', [user.id])
}

function force_logout(user: AdminUser) {
  void perform_command('KICK', [user.id])
}

function toggle_verified(user: AdminUser) {
  if (user.is_verified) {
    void perform_command('UNVERIFY', [user.id])
    return
  }

  request_verification_note([user.id])
}

function toggle_admin(user: AdminUser) {
  void perform_command(user.is_admin ? 'DEMOTE' : 'PROMOTE', [user.id])
}

onMounted(() => {
  poll_timer = setInterval(() => {
    void reload_users('polling')
  }, poll_interval_ms)
})

onUnmounted(() => {
  if (poll_timer) {
    clearInterval(poll_timer)
    poll_timer = null
  }
})

await reload_users('initial')
</script>

<style scoped>
  .admin-hero {
    position: relative;
    isolation: isolate;
  }

  .admin-hero::before {
    content: '';
    position: absolute;
    inset: -20% auto auto -10%;
    width: 18rem;
    height: 18rem;
    border-radius: 9999px;
    background: radial-gradient(circle, rgba(245, 158, 11, 0.24) 0%, rgba(245, 158, 11, 0) 70%);
    z-index: -1;
  }

  .admin-hero::after {
    content: '';
    position: absolute;
    inset: auto -8% -22% auto;
    width: 20rem;
    height: 20rem;
    border-radius: 9999px;
    background: radial-gradient(circle, rgba(14, 165, 233, 0.22) 0%, rgba(14, 165, 233, 0) 72%);
    z-index: -1;
  }

  .admin-stat-card {
    @apply rounded-2xl border border-white/70 bg-white/85 px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-900/80;
  }

  .admin-skeleton-card {
    @apply h-56 rounded-[1.5rem] border border-slate-200/80 bg-gradient-to-br from-white via-slate-50 to-slate-100 dark:border-slate-700 dark:from-slate-900 dark:via-slate-900 dark:to-slate-800;
    animation: admin-pulse 1.4s ease-in-out infinite;
  }

  .user-card-grid :deep(> *) {
    @apply mb-4 last:mb-0;
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
