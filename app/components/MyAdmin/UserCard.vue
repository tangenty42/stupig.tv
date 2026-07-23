<template>
  <Card
    class="admin-user-card"
    :class="selected ? '!border-primary-400 dark:!border-primary-400' : ''"
    @click="emit('toggle-select', user.id)"
  >
    <template #content>
      <div class="flex items-start gap-4">
        <div class="shrink-0">
          <ClientOnly>
            <OverlayBadge :severity="user.is_online ? 'success' : 'secondary'" class="avatar-online-badge">
              <MyAvatar
                :user="{ id: user.id, username: user.username, avatar_file: user.avatar_file }"
                size="large"
                previewable
              />
            </OverlayBadge>
            <template #fallback>
              <MyAvatar
                :user="{ id: user.id, username: user.username, avatar_file: user.avatar_file }"
                size="large"
                previewable
              />
            </template>
          </ClientOnly>
        </div>

        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <div class="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {{ user.username }}
            </div>
            <MyIcon v-if="user.is_verified" name="lucide:badge-check" class="shrink-0 text-emerald-500" />
          </div>

          <div class="mt-0.5 text-xs text-slate-500">
            {{ user.phone ? `手机号 ${user.phone}` : '未绑定手机号' }}
          </div>

          <div class="mt-0.5 text-xs text-slate-500">
            UID #{{ user.id }}
          </div>

          <div class="mt-3 flex flex-wrap items-center gap-2">
            <MyBadge v-if="user.is_verified" type="success">
              <span class="inline-flex items-center gap-1"><MyIcon name="lucide:badge-check" />认证</span>
            </MyBadge>
            <MyBadge v-if="user.is_admin" type="warning">
              <span class="inline-flex items-center gap-1"><MyIcon name="lucide:shield-check" />管理员</span>
            </MyBadge>
            <MyBadge v-if="user.is_banned" type="error">
              <span class="inline-flex items-center gap-1"><MyIcon name="lucide:ban" />已封禁</span>
            </MyBadge>
          </div>

          <div class="mt-3 text-xs text-slate-400">
            注册于：{{ duration_build_string([user.created_at, date_now], ['{formated}前', '刚刚']) }}
          </div>
          <div class="mt-1 text-xs text-slate-400">
            最近登录：{{ user.last_login_at ? duration_build_string([user.last_login_at, date_now], ['{formated}前', '刚刚']) : '-' }}
          </div>
          <div class="mt-1 text-xs text-slate-400">
            最近在线：{{ user.last_online_at ? duration_build_string([user.last_online_at, date_now], ['{formated}前', '刚刚']) : '-' }}
          </div>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
        <NuxtLink target="_blank" :to="profile_link" @click.stop>
          <Button size="small" text label="修改信息">
            <template #icon>
              <MyIcon name="lucide:square-pen" />
            </template>
          </Button>
        </NuxtLink>

        <Button
          size="small"
          :severity="user.is_banned ? 'success' : 'danger'"
          text
          :loading="disable_pending"
          :label="user.is_banned ? '解封' : '封禁'"
          @click.stop="toggle_disabled"
        >
          <template #icon>
            <MyIcon :name="user.is_banned ? 'lucide:circle-check' : 'lucide:ban'" />
          </template>
        </Button>

        <Button size="small" severity="secondary" text :loading="logout_pending" label="强制下线" @click.stop="force_logout">
          <template #icon>
            <MyIcon name="lucide:log-out" />
          </template>
        </Button>

        <Button
          size="small"
          :severity="user.is_verified ? 'secondary' : 'success'"
          text
          :label="user.is_verified ? '移除认证' : '授予认证'"
          @click.stop="toggle_verified"
        >
          <template #icon>
            <MyIcon :name="user.is_verified ? 'lucide:badge-x' : 'lucide:badge-check'" />
          </template>
        </Button>

        <Button
          size="small"
          :severity="user.is_admin ? 'secondary' : 'warn'"
          text
          :label="user.is_admin ? '移除管理员' : '设为管理员'"
          @click.stop="toggle_admin"
        >
          <template #icon>
            <MyIcon :name="user.is_admin ? 'lucide:shield-off' : 'lucide:shield-check'" />
          </template>
        </Button>
      </div>
    </template>
  </Card>
</template>

<script setup lang="ts">
import type { ApiAdminUser } from '~/composables/useApi'

const props = defineProps<{
  user: ApiAdminUser
  selected?: boolean
  disable_pending?: boolean
  logout_pending?: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-disabled', user: ApiAdminUser): void
  (e: 'force-logout', user: ApiAdminUser): void
  (e: 'toggle-verified', user: ApiAdminUser): void
  (e: 'toggle-admin', user: ApiAdminUser): void
  (e: 'toggle-select', id: number): void
}>()

const profile_link = computed(() => `/u/${props.user.id}`)

const date_now = useReactiveDateNow()

function toggle_disabled() {
  emit('toggle-disabled', props.user)
}

function force_logout() {
  emit('force-logout', props.user)
}

function toggle_verified() {
  emit('toggle-verified', props.user)
}

function toggle_admin() {
  emit('toggle-admin', props.user)
}
</script>

<style scoped>
  .admin-user-card {
    @apply mb-4 break-inside-avoid rounded-2xl border border-slate-200 bg-white/80 shadow-sm transition-shadow hover:shadow-md dark:border-slate-700 dark:bg-slate-900/50;
  }

  .avatar-online-badge {
    @apply inline-flex leading-none;
  }

  .avatar-online-badge :deep(.p-badge) {
    @apply w-5 h-5;
    inset-block-start: auto;
    inset-block-end: 0;
    inset-inline-end: 0;
    transform: none;
  }
</style>
