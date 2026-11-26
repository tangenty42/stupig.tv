<template>
  <div class="pb-12 pt-8 transition-opacity duration-200" :class="{ 'opacity-60 delay-150': switching }" :aria-busy="switching">
    <!-- One view is mounted at a time, so leaving a view stops its polling. Each view awaits its
         first query; this boundary keeps the previous view on screen until the next one resolves
         instead of blanking the page, while `suspensible` lets the page boundary wait on first entry. -->
    <Suspense v-if="can_read && ! access_denied" suspensible @pending="switching = true" @resolve="show_selected_view">
      <component
        :is="selected_view === 'status' ? MyAdminRunView : MyAdminUsersView"
        v-bind="selected_view === 'status' ? { focusStorage: route.query.view === 'storage' } : {}"
        @access-denied="leave_console"
      >
        <template #header="{ updated_at }">
          <header>
            <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-3">
              <h1 class="text-3xl sm:text-4xl">
                {{ shown_view === 'users' ? '用户管理' : '运行状态' }}
              </h1>
              <SelectButton
                v-model="selected_view"
                :options="view_options"
                option-label="label"
                option-value="value"
                :allow-empty="false"
                aria-label="控制台视图"
                size="small"
              >
                <template #option="{ option }">
                  <span>
                    <MyIcon :name="option.icon" aria-hidden="true" class="me-1.5" />{{ option.label }}
                  </span>
                </template>
              </SelectButton>
            </div>
            <p class="mt-4 flex flex-wrap items-baseline gap-x-2 text-xs text-slate-500 dark:text-slate-400">
              <span><MyIcon name="lucide:refresh-cw" class="mr-1" aria-hidden="true" />每 {{ poll_seconds }} 秒自动更新</span>
              <span><time v-if="updated_at" :datetime="updated_at.toISOString()">{{ relative_time(updated_at.toISOString(), true) }} 更新</time><span v-else>—</span></span>
            </p>
          </header>
        </template>
      </component>
    </Suspense>
  </div>
</template>

<script setup lang="ts">
import { has_permission } from '@shared/permissions'
import { settings } from '@shared/settings'
import { MyAdminRunView, MyAdminUsersView } from '#components'
import { useAdminRelativeTime } from '~/features/admin/status'

definePageMeta({
  middleware: 'require-admin-auth',
})

useSeoMeta({ robots: 'noindex, nofollow' })

type AdminView = 'users' | 'status'

const route = useRoute()
const router = useRouter()
const relative_time = useAdminRelativeTime()
const { user } = useAuth()
const can_read = computed(() => has_permission(user.value, 'admin_access', 'readonly'))
const access_denied = ref(false)

function leave_console() {
  access_denied.value = true
  if (import.meta.client)
    void router.replace('/')
}

watch(can_read, (allowed) => {
  if (! allowed)
    leave_console()
})

const view_options: { label: string, value: AdminView, icon: string }[] = [
  { label: '用户', value: 'users', icon: 'lucide:users' },
  { label: '运行状态', value: 'status', icon: 'lucide:activity' },
]

const selected_view = computed<AdminView>({
  get: () => ['status', 'tasks', 'storage'].some(view => view === route.query.view) ? 'status' : 'users',
  set: (value) => { void router.replace({ query: { ... route.query, view: value === 'users' ? undefined : value } }) },
})

// The switch reflects the choice at once; the title and polling note follow the view actually on screen.
const shown_view = ref(selected_view.value)
const switching = ref(false)
function show_selected_view() {
  switching.value = false
  shown_view.value = selected_view.value
}

const poll_seconds = computed(() => shown_view.value === 'users' ? settings.app.admin.pollIntervalSeconds : settings.app.admin.statusPollIntervalSeconds)
</script>
