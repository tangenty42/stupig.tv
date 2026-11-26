<template>
  <MyHeightSection tag="section" class="section-card-collapse">
    <div class="w-full flex flex-wrap justify-between gap-y-6">
      <OverlayBadge :severity="avatar_badge_severity" :value="avatar_badge_label" class="avatar-online-badge">
        <MyAvatar :user="profile" size="xlarge" previewable />
      </OverlayBadge>
      <div class="flex flex-col gap-2">
        <Button
          v-if="profile.editable"
          size="small"
          text
          severity="primary"
          label="更换"
          :loading="avatar_upload_pending"
          :disabled="avatar_upload_pending"
          @click="avatar_crop_upload?.open_picker()"
        >
          <template #icon>
            <MyIcon name="lucide:image-up" />
          </template>
        </Button>
        <Button
          v-if="profile.editable && profile.avatar_file"
          size="small"
          text
          severity="secondary"
          label="删除"
          :loading="avatar_delete_pending"
          :disabled="avatar_delete_pending"
          @click="confirm_delete_avatar"
        >
          <template #icon>
            <MyIcon name="lucide:trash-2" />
          </template>
        </Button>
      </div>
    </div>

    <div class="w-full mt-6">
      <div class="font-medium text-3xl">
        <span>{{ profile.username }}<MyIcon v-if="profile.is_verified" name="lucide:badge-check" class="ms-2 text-emerald-500" /></span>
      </div>
      <div class="mt-6 flex flex-wrap items-start gap-2">
        <span v-if="profile.is_verified && profile.verified_note" class="label border-emerald-300 dark:border-emerald-700/50 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
          <span class="shrink-0 font-semibold">
            <MyIcon name="lucide:badge-check" class="me-1 text-emerald-500" />已认证
          </span>
          <span>{{ profile.verified_note }}</span>
        </span>
        <span class="label border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400">
          <span class="shrink-0 font-semibold">UID</span>
          <span>#{{ profile.id }}</span>
        </span>
      </div>
    </div>

    <div class="mt-12 grid gap-x-4 gap-y-6 sm:gap-y-4 text-sm justify-items-stretch sm:grid-cols-2 md:grid-cols-3 sm:items-start">
      <div v-for="item in profile_meta_items" :key="item.key" class="mb-2 rounded-sm flex flex-col items-start overflow-hidden border border-slate-200/50 dark:border-slate-700/50 bg-slate-100 dark:bg-slate-800/50">
        <div class="h-full w-full px-2 py-1 flex items-center justify-start border-b border-slate-300/50 dark:border-slate-700/50 bg-slate-200 dark:bg-slate-800 rounded-b-sm">
          <div class="w-full flex gap-2 items-center justify-between text-slate-500 dark:text-slate-400 px-2 py-1">
            <div class="shrink-0 text-lg font-semibold">
              <MyIcon :name="item.icon" class="me-2" />{{ item.label }}
            </div>
            <div class="shrink-0">
              <Button
                v-if="item.key === 'birthday' && profile.editable"
                size="small"
                text
                severity="secondary"
                label="编辑"
                @click="birthday_editor_visible = true"
              >
                <template #icon>
                  <MyIcon name="lucide:pencil" />
                </template>
              </Button>
              <Button
                v-if="item.key === 'phone' && profile.editable"
                size="small"
                text
                severity="secondary"
                label="更换"
                @click="emit('editPhone')"
              >
                <template #icon>
                  <MyIcon name="lucide:lock" />
                </template>
              </Button>
            </div>
          </div>
        </div>
        <div class="h-full w-full ps-3 pe-1 py-3 sm:py-2 flex justify-center">
          <div class="text-slate-500 dark:text-slate-400">
            <template v-if="item.type === 'date'">
              <div class="break-all flex flex-wrap gap-x-2 gap-y-1 items-center justify-center">
                <span class="flex flex-wrap gap-x-1 items-center justify-center">
                  <span>{{ item.value_date!.year() }}</span>
                  <span class="muted">年</span>
                  <span>{{ item.value_date!.month() + 1 }}</span>
                  <span class="muted">月</span>
                  <span>{{ item.value_date!.date() }}</span>
                  <span class="muted">日</span>
                </span>
                <MyBadge v-if="build_date_budget_text(item)">
                  {{ build_date_budget_text(item) }}
                </MyBadge>
              </div>
            </template>
            <span v-else class="break-all mr-2">{{ item.value ?? '-' }}</span>
          </div>
        </div>
      </div>
    </div>
  </MyHeightSection>

  <MyHeightSection v-if="profile.is_admin || profile.permissions.length" tag="section" class="section-card-collapse">
    <h2 class="mb-6">
      权限
    </h2>

    <MyBadge v-if="profile.is_admin" outlined type="warning">
      <span><MyIcon name="lucide:shield-check" class="me-1" />管理员·大权独揽</span>
    </MyBadge>

    <div v-else class="flex flex-wrap gap-2">
      <MyPermissionBadge v-for="grant in profile.permissions" :key="grant.field" :grant="grant" />
    </div>
  </MyHeightSection>

  <MyAvatarCropUpload ref="avatar_crop_upload" :target-id="is_operating_other ? profile.id : null" />

  <MyDialog v-model:visible="birthday_editor_visible" header="更新生日" :pending="birthday_pending">
    <Form id="birthday-form" :resolver="birthday_resolver" :initial-values="birthday_form_default" :validate-on-value-update="true" :validate-on-blur="true" @submit="submit_birthday">
      <MyFormField name="birthday" label="生日" as="DatePicker" autocomplete="bday" />
    </Form>

    <template #footer>
      <Button type="submit" form="birthday-form" label="确定" :loading="birthday_pending" :disabled="birthday_pending">
        <template #icon>
          <MyIcon name="lucide:check" />
        </template>
      </Button>
    </template>
  </MyDialog>
</template>

<script setup lang="ts">
import type { FormSubmitEvent } from '@primevue/forms'
import type { Profile } from '@shared/types/user'
import type { Dayjs } from 'dayjs'
import { Form } from '@primevue/forms'
import { zodResolver } from '@primevue/forms/resolvers/zod'
import { form_schema } from '@shared/schemas'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import { useAccountProfileDetails } from '~/features/account/profile'

const props = defineProps<{
  profile: Profile
  isOperatingOther: boolean
}>()
const emit = defineEmits<{ editPhone: [] }>()

dayjs.extend(utc)
const profile = toRef(props, 'profile')
const is_operating_other = toRef(props, 'isOperatingOther')
const { birthday_pending, avatar_delete_pending, update_birthday, delete_avatar } = useAccountProfileDetails(profile, is_operating_other)
const { confirm_require } = useMyConfirm()
const time_context = useDisplayTimeContext()
const reactive_date_now = useReactiveDateNow()
const avatar_crop_upload = ref<{ open_picker: () => void, pending: boolean } | null>(null)
const avatar_upload_pending = computed(() => avatar_crop_upload.value?.pending ?? false)
const birthday_editor_visible = ref(false)
const birthday_resolver = zodResolver(form_schema.profile_birthday_update)
const birthday_form_default = computed(() => ({
  birthday: profile.value.birthday ? dayjs.utc(profile.value.birthday).toISOString() : null,
}))

const avatar_badge_severity = computed(() => {
  if (profile.value.is_banned)
    return 'danger'
  if (profile.value.is_online)
    return 'success'
  return 'secondary'
})
const avatar_badge_label = computed(() => {
  if (profile.value.is_banned)
    return '被封禁'
  if (profile.value.is_online)
    return '在线'
  return '离线'
})

interface ProfileMetaItem {
  key: string
  label: string
  value?: string
  type?: 'text' | 'date'
  value_date?: Dayjs
  date_template?: string | [string, string]
  icon: string
}

const profile_meta_items = computed(() => [
  {
    key: 'created_at',
    label: '注册时间',
    type: 'date',
    value_date: localize_date(profile.value.created_at, false, time_context.value.timezone),
    date_template: ['已成为蠢猪{formated}', '刚刚成为蠢猪'],
    icon: 'lucide:user-round-check',
  },
  ... (profile.value.last_seen_at
    ? [{
        key: 'last_seen_at',
        label: '最近活跃',
        type: 'date',
        value: profile.value.last_seen_at,
        value_date: localize_date(profile.value.last_seen_at, false, time_context.value.timezone),
        date_template: ['{formated}前', '刚刚'],
        icon: 'lucide:person-standing',
      }]
    : []),
  ... (profile.value.sensitive_readable
    ? [{
        key: 'phone',
        label: '手机号',
        value: profile.value.phone || '暂未设置',
        icon: 'lucide:phone',
      }]
    : []),
  {
    key: 'birthday',
    label: '生日',
    type: profile.value.birthday ? 'date' : 'text',
    value: profile.value.birthday ? undefined : '暂未设置',
    value_date: profile.value.birthday ? localize_date(profile.value.birthday, false, time_context.value.timezone) : undefined,
    date_template: '{Y} 岁',
    icon: 'lucide:cake',
  },
] as ProfileMetaItem[])

function build_date_budget_text(item: ProfileMetaItem) {
  const normal = item.value_date!.isBefore(reactive_date_now.value)
  if (item.key === 'birthday' && ! normal) {
    return duration_build_string([item.value_date!, reactive_date_now.value], '还有{formated}重生🪽', { just_now: '几十秒', timezone: time_context.value.timezone })
  }
  if (item.date_template) {
    return duration_build_string([item.value_date!, reactive_date_now.value], item.date_template, { timezone: time_context.value.timezone })
  }
  return null
}

function confirm_delete_avatar(event: Event) {
  confirm_require(event, '确定要删除头像吗？', delete_avatar)
}

async function submit_birthday(event: FormSubmitEvent) {
  if (event.valid && await update_birthday(form_schema.profile_birthday_update.parse(event.values))) {
    birthday_editor_visible.value = false
  }
}
</script>

<style scoped>
.label {
  @apply inline-flex items-start gap-2 max-w-sm rounded-full px-3 py-2 text-sm border;
}

.avatar-online-badge {
  @apply inline-flex leading-none;
}

.avatar-online-badge :deep(.p-badge) {
  @apply min-w-5 rounded-full;
  inset-block-start: auto;
  inset-block-end: 0;
  inset-inline-end: 0;
  transform: none;
}
</style>
