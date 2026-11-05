<template>
  <MyHeightSection tag="section" class="section-card-collapse">
    <div class="mb-6 flex flex-wrap items-center justify-between gap-2">
      <h2>
        登录记录
      </h2>
      <SelectButton
        v-model="session_filter"
        :options="session_filter_options"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        size="small"
        aria-label="登录记录筛选"
      >
        <template #option="{ option }">
          <span class="flex items-center gap-1.5">
            <MyIcon :name="option.icon" />
            <span>{{ option.label }}</span>
          </span>
        </template>
      </SelectButton>
    </div>

    <div class="mt-4 columns-1 gap-4 md:columns-2">
      <div
        v-for="record in visible_sessions"
        :key="record.id"
        class="mb-4 break-inside-avoid rounded-lg border border-slate-200/80 bg-white/70 px-6 py-6 last:mb-0 dark:border-slate-700 dark:bg-slate-900/50"
      >
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="w-full min-w-0">
            <div class="flex flex-wrap gap-x-2 items-center">
              <div class="text-slate-500 dark:text-slate-400">
                <span class="text-lg font-semibold">{{ ua_label(record.user_agent) }}</span>
                <span v-if="record.is_current" class="ms-2 text-sm">(当前设备)</span>
              </div>
            </div>
            <div class="mt-1.5 w-full flex items-center justify-between">
              <MyBadge outlined :type="session_status_severity(record)">
                {{ session_status_text(record) }}
              </MyBadge>
              <Button
                v-if="! record.is_current"
                size="small"
                severity="secondary"
                text
                :loading="pending_id === record.id"
                label="强制退出"
                @click="confirm_force_logout($event, record.id)"
              >
                <template #icon>
                  <MyIcon name="lucide:log-out" />
                </template>
              </Button>
            </div>
          </div>
        </div>

        <div class="mt-4 grid gap-1 text-xs text-slate-500 dark:text-slate-400">
          <div>
            IP：{{ record.last_seen_ip || record.login_ip || '-' }}
          </div>
          <div v-if="record.login_at && record.last_seen_at">
            登录：{{ duration_build_string([record.login_at, date_now], ['{formated}前', '刚刚'], { timezone: time_context.timezone }) }}
          </div>
          <div>
            最近活跃：{{ duration_build_string([record.last_seen_at, date_now], ['{formated}前', '刚刚'], { timezone: time_context.timezone }) }}
          </div>
        </div>
      </div>
    </div>

    <div v-if="! visible_sessions.length" class="my-4 w-full text-center text-slate-500 dark:text-slate-400">
      ？！暂无记录！？
    </div>
  </MyHeightSection>
</template>

<script setup lang="ts">
import type { SessionRecord } from '@shared/types/session'
import type { Profile } from '@shared/types/user'
import { useAccountSessions } from '~/features/account/profile'

const props = defineProps<{
  profile: Profile
  isOperatingOther: boolean
}>()
const { confirm_require } = useMyConfirm()
const time_context = useDisplayTimeContext()
const date_now = useReactiveDateNow()
const profile = toRef(props, 'profile')
const is_operating_other = toRef(props, 'isOperatingOther')
const { sessions, pending_id, ready, force_logout } = useAccountSessions(profile, is_operating_other)
await ready

type SessionFilter = 'valid' | 'expired'
const session_filter_options: { label: string, value: SessionFilter, icon: string }[] = [
  { label: '有效', value: 'valid', icon: 'lucide:circle-check' },
  { label: '已过期', value: 'expired', icon: 'lucide:hourglass' },
]
const session_filter = ref<SessionFilter>('valid')
const visible_sessions = computed(() => {
  const records = sessions.value?.records ?? []
  return records.filter(record => session_filter.value === 'expired' ? record.is_expired : ! record.is_expired)
})

function confirm_force_logout(event: Event, id: number) {
  confirm_require(event, '确定要强制退出该设备吗？', () => force_logout(id))
}

function session_status_text(record: SessionRecord) {
  if (record.is_logged_out)
    return '已退出'
  if (record.is_expired)
    return '已过期'
  return record.is_online ? '在线' : '离线'
}

function session_status_severity(record: SessionRecord) {
  return ! record.is_logged_out && record.is_online ? 'success' : 'info'
}
</script>
