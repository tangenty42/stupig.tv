<template>
  <MyHeightSection v-if="active" tag="section" class="section-card-collapse">
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
          <span>
            <MyIcon :name="option.icon" class="me-1.5" />{{ option.label }}
          </span>
        </template>
      </SelectButton>
    </div>

    <div v-if="! sessions && loading" class="my-4 flex justify-center text-slate-500 dark:text-slate-400" role="status" aria-label="正在加载登录记录">
      <MyIcon name="lucide:loader-circle" size="2rem" class="animate-spin" />
    </div>
    <MyContentListLoadError v-else-if="! sessions && load_failed" class="py-8" @retry="refresh" />
    <div v-else-if="visible_sessions.length" class="mt-4 columns-1 gap-4 md:columns-2">
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
                v-if="! record.is_current && profile.editable"
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

    <div v-else-if="sessions" class="my-4 w-full text-center text-slate-500 dark:text-slate-400">
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
  isViewingOther: boolean
}>()
const { confirm_require } = useMyConfirm()
const time_context = useDisplayTimeContext()
const date_now = useReactiveDateNow()
const profile = toRef(props, 'profile')
const is_viewing_other = toRef(props, 'isViewingOther')
const { sessions, active, loading, load_failed, pending_id, ready, refresh, force_logout } = useAccountSessions(profile, is_viewing_other)
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
