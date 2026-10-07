<template>
  <div class="space-y-12 pb-12 pt-8">
    <template v-if="profile">
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
              label="更换头像"
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
              label="删除头像"
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
          <div class="font-medium flex items-center gap-x-2 gap-y-0.5 text-3xl">
            <span>{{ profile.username }}</span>
            <MyIcon v-if="profile.is_verified" name="lucide:badge-check" class="text-emerald-500" />
          </div>
          <div class="mt-6 flex flex-wrap items-start gap-2">
            <span v-if="profile.is_verified && profile.verified_note" class="label border-emerald-300 dark:border-emerald-700/50 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              <div class="shrink-0 flex items-center gap-1">
                <MyIcon v-if="profile.is_verified" name="lucide:badge-check" class="text-emerald-500" />
                <span class="font-semibold">已认证</span>
              </div>
              <span>{{ profile.verified_note }}</span>
            </span>
            <span class="label border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400">
              <span class="shrink-0 font-semibold">UID</span>
              <p>#{{ profile.id }}</p>
            </span>
          </div>
        </div>

        <div class="mt-12 grid gap-x-4 gap-y-6 sm:gap-y-4 text-sm justify-items-stretch sm:grid-cols-2 md:grid-cols-3 sm:items-start">
          <div v-for="item in profile_meta_items" :key="item.key" class="mb-2 rounded-sm flex flex-col items-start overflow-hidden border border-slate-200/50 dark:border-slate-700/50 bg-slate-100 dark:bg-slate-800/50">
            <div class="h-full w-full px-2 py-1 flex items-center justify-start border-b border-slate-300/50 dark:border-slate-700/50 bg-slate-200 dark:bg-slate-800 rounded-b-sm">
              <div class="w-full flex gap-2 items-center justify-between text-slate-500 dark:text-slate-400 px-2 py-1">
                <div class="shrink-0 flex gap-2 items-center">
                  <MyIcon :name="item.icon" class="text-xl" />
                  <span class="me-1 text-lg font-semibold">{{ item.label }}</span>
                </div>
                <div class="shrink-0">
                  <Button
                    v-if="item.key === 'birthday' && profile.editable"
                    size="small"
                    text
                    severity="secondary"
                    label="编辑"
                    @click="open_birthday_editor"
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
                    @click="scroll_to_phone_form"
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
          <span><MyIcon name="lucide:shield-check" class="me-1" />管理员·全部权限</span>
        </MyBadge>

        <div v-else class="flex flex-wrap gap-2">
          <MyPermissionBadge v-for="grant in profile.permissions" :key="grant.field" :grant="grant" />
        </div>
      </MyHeightSection>

      <template v-if="profile.editable">
        <MyHeightSection tag="section" class="section-card-collapse">
          <h2 class="mb-6">
            修改密码
          </h2>

          <div v-if="is_operating_other">
            <Form ref="operate_password_form" :resolver="operate_password_resolver" :initial-values="form_default.profile_operate_password_reset" :validate-on-value-update="true" :validate-on-blur="true" @submit="on_submit_operate_password">
              <div class="grid gap-4 sm:grid-cols-2">
                <MyFormField name="new_password" label="新密码" as="Password" autocomplete="new-password" />
                <MyFormField name="confirm_new_password" label="确认新密码" as="Password" autocomplete="new-password" no-paste />
              </div>
              <div class="mt-4 flex flex-wrap items-end gap-3">
                <Button type="submit" label="直接修改" :loading="operate_password_pending" :disabled="operate_password_pending">
                  <template #icon>
                    <MyIcon name="lucide:lock" />
                  </template>
                </Button>
              </div>
            </Form>
          </div>

          <!-- <KeepAlive v-else> -->
          <Form v-else-if="password_mode === 'old'" key="password-old" ref="password_form" :resolver="password_resolver" :initial-values="form_default.profile_change_password" :validate-on-value-update="true" :validate-on-blur="true" @submit="on_submit_password">
            <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <MyFormField name="old_password" label="旧密码" as="Password" autocomplete="current-password" />
              <MyFormField name="new_password" label="新密码" as="Password" autocomplete="new-password" />
              <MyFormField name="confirm_new_password" label="确认新密码" as="Password" autocomplete="new-password" no-paste />
            </div>
            <div class="mt-4 flex flex-wrap items-end justify-between gap-3">
              <Button type="submit" label="修改" :loading="password_pending" :disabled="password_pending">
                <template #icon>
                  <MyIcon name="lucide:lock" />
                </template>
              </Button>
              <Button label="打倒旧密码，我要新方案" severity="primary" text size="small" @click="password_mode = 'otp'" />
            </div>
          </Form>

          <Form v-else key="password-otp" ref="password_otp_form" :resolver="password_otp_resolver" :initial-values="form_default.profile_change_password_by_otp" :validate-on-value-update="true" :validate-on-blur="true" @submit="on_submit_password_by_otp">
            <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <MyFormField
                name="otp"
                as="InputOtp"
                label="手机验证码"
                :hint="`将发送至 ${profile.phone!}`"
                :otp-send="{ sendHandler: send_password_change_otp, targetPhone: profile.phone!, purpose: 'change_password' }"
              />
              <MyFormField name="new_password" label="新密码" as="Password" autocomplete="new-password" />
              <MyFormField name="confirm_new_password" label="确认新密码" as="Password" autocomplete="new-password" no-paste />
            </div>
            <div class="mt-4 flex flex-wrap items-end justify-between gap-3">
              <Button type="submit" label="修改" :loading="password_otp_pending" :disabled="password_otp_pending">
                <template #icon>
                  <MyIcon name="lucide:lock" />
                </template>
              </Button>
              <Button label="旧密码老师，我还记得你" severity="primary" text size="small" @click="password_mode = 'old'" />
            </div>
          </Form>
          <!-- </KeepAlive> -->
        </MyHeightSection>

        <MyHeightSection ref="phone_form_section" tag="section" class="section-card-collapse">
          <h2 class="mb-6">
            更换手机号
          </h2>

          <Form v-if="is_operating_other" ref="operate_phone_form" :resolver="operate_phone_resolver" :initial-values="form_default.profile_operate_phone_change" :validate-on-value-update="true" :validate-on-blur="true" @submit="on_submit_operate_phone">
            <div class="grid gap-4 sm:grid-cols-2">
              <MyFormField
                name="new_phone"
                label="新手机号"
                as="Phone"
                autocomplete="tel"
              />
            </div>
            <div class="mt-4 flex flex-wrap items-end gap-3">
              <Button type="submit" label="直接更换" :loading="operate_phone_pending" :disabled="operate_phone_pending">
                <template #icon>
                  <MyIcon name="lucide:lock" />
                </template>
              </Button>
            </div>
          </Form>

          <Form v-else ref="phone_form" :resolver="phone_resolver_with_old" :initial-values="form_default.profile_change_phone" :validate-on-value-update="true" :validate-on-blur="true" @submit="submit_change_phone">
            <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <MyFormField
                name="old_otp"
                as="InputOtp"
                label="旧手机号验证码"
                :hint="`将发送至 ${profile.phone!}`"
                :otp-send="{ sendHandler: send_old_phone_otp, targetPhone: profile.phone!, purpose: 'verify_old_phone' }"
              />
              <MyFormField
                name="new_phone"
                label="新手机号"
                as="Phone"
                autocomplete="tel"
              />
              <MyFormField
                name="new_otp"
                as="InputOtp"
                label="新手机号验证码"
                :hint="new_phone ? `将发送至 ${new_phone}` : '请先输入新手机号'"
                :otp-send="{ sendHandler: send_new_phone_otp, targetPhone: new_phone, targetFieldName: 'new_phone', purpose: 'change_phone' }"
              />
            </div>
            <div class="mt-4 flex flex-wrap items-end justify-between gap-3">
              <Button type="submit" label="更换" :loading="phone_change_pending" :disabled="phone_change_pending">
                <template #icon>
                  <MyIcon name="lucide:lock" />
                </template>
              </Button>
              <Button label="我旧手机号无法接收验证码！" severity="primary" text size="small" @click="info('受着，或者联系我们！')" />
            </div>
          </Form>
        </MyHeightSection>

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
              v-for="record in self_session_records"
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
                      :loading="self_session_pending_id === record.id"
                      label="强制退出"
                      @click="confirm_force_logout_session($event, record.id, record.is_current)"
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
                  登录：{{ duration_build_string([record.login_at, date_now], ['{formated}前', '刚刚']) }}
                </div>
                <div>
                  最近活跃：{{ duration_build_string([record.last_seen_at, date_now], ['{formated}前', '刚刚']) }}
                </div>
              </div>
            </div>
          </div>

          <div v-if="! self_session_records.length" class="my-4 w-full text-center text-slate-500 dark:text-slate-400">
            ？！暂无记录！？
          </div>
        </MyHeightSection>

        <MyAvatarCropUpload ref="avatar_crop_upload" :target-id="is_operating_other && profile ? profile.id : null" />
      </template>

      <MyDialog v-model:visible="birthday_editor_visible" header="更新生日" :pending="birthday_pending">
        <Form id="birthday-form" :resolver="birthday_resolver" :initial-values="birthday_form_default" :validate-on-value-update="true" :validate-on-blur="true" @submit="on_submit_birthday">
          <MyFormField name="birthday" label="生日" as="DatePicker" autocomplete="bday" />
        </Form>

        <template #footer>
          <div class="flex justify-end gap-2">
            <Button label="取消" severity="secondary" text :disabled="birthday_pending" @click="birthday_editor_visible = false" />
            <Button type="submit" form="birthday-form" label="确定" :loading="birthday_pending" :disabled="birthday_pending">
              <template #icon>
                <MyIcon name="lucide:check" />
              </template>
            </Button>
          </div>
        </template>
      </MyDialog>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { FormInstance, FormSubmitEvent } from '@primevue/forms'
import type { SessionOverview, SessionRecord } from '@shared/types/session'
import type { Profile } from '@shared/types/user'
import type { Dayjs } from 'dayjs'
import { Form } from '@primevue/forms'
import { zodResolver } from '@primevue/forms/resolvers/zod'
import { has_permission } from '@shared/permissions'
import { form_default, form_schema } from '@shared/schemas'
import { sync_resource } from '@shared/types/sync'

import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import { useCaptcha } from '~/composables/useCaptcha'
import { avatar_url } from '~/utils/avatar'

dayjs.extend(utc)

const route = useRoute()
const runtime_config = useRuntimeConfig()
const { auth: auth_api, profile: profile_api } = useApi()
const { user: auth_user } = useAuth()
const { error, ok, info } = useMyToast()
const { verify: captcha_verify } = useCaptcha()
const { confirm_require } = useMyConfirm()
const date_now = useReactiveDateNow()

const sync_loading = useState('sync_loading', () => false)
const profile = useState<Profile | null>('profile', () => null)

useHead({
  title: computed(() => profile.value ? `用户主页 - ${profile.value.username}` : undefined),
})

const static_url = useStaticUrl()

useSeoMeta({
  description: computed(() => profile.value ? `蠢猪小组成员「${profile.value.username}」的主页` : undefined),
  ogTitle: computed(() => profile.value ? `用户主页 - ${profile.value.username}` : undefined),
  ogDescription: computed(() => profile.value ? `蠢猪小组成员「${profile.value.username}」的主页` : undefined),
  ogType: 'profile',
  ogImage: computed(() => (profile.value ? avatar_url(static_url, profile.value.avatar_file, profile.value.avatar_version) : null) ?? undefined),
})

const is_operating_other = computed(() => {
  return has_permission(auth_user.value, 'admin_access', 'full') && !! profile.value && profile.value.id !== auth_user.value?.id
})
const avatar_badge_severity = computed(() => {
  if (profile.value?.is_banned)
    return 'danger'
  if (profile.value?.is_online)
    return 'success'
  return 'secondary'
})
const avatar_badge_label = computed(() => {
  if (profile.value?.is_banned)
    return '被封禁'
  if (profile.value?.is_online)
    return '在线'
  return '离线'
})

const password_form = ref<FormInstance>()
const password_otp_form = ref<FormInstance>()
const operate_password_form = ref<FormInstance>()
const operate_phone_form = ref<FormInstance>()
const phone_form = ref<FormInstance>()
const phone_form_section = ref<{ el: HTMLElement | null } | null>(null)
const avatar_crop_upload = ref<{ open_picker: () => void, pending: boolean } | null>(null)
const avatar_upload_pending = computed(() => avatar_crop_upload.value?.pending ?? false)

const birthday_editor_visible = ref(false)
const birthday_pending = ref(false)
const avatar_delete_pending = ref(false)
const password_pending = ref(false)
const password_otp_pending = ref(false)
const operate_password_pending = ref(false)
const operate_phone_pending = ref(false)
const password_mode = ref<'old' | 'otp'>('old')
const otp_sending = ref(false)

// Phone change
const new_phone = computed(() => String(phone_form.value?.getFieldState('new_phone')?.value || ''))
const old_phone_otp_sending = ref(false)
const new_phone_otp_sending = ref(false)
const phone_change_pending = ref(false)
const self_sessions_loading = ref(false)
const self_session_pending_id = ref<number | null>(null)
const self_sessions = ref<SessionOverview | null>(null)

const birthday_resolver = zodResolver(form_schema.profile_birthday_update)
const password_resolver = zodResolver(form_schema.profile_change_password)
const password_otp_resolver = zodResolver(form_schema.profile_change_password_by_otp)
const operate_password_resolver = zodResolver(form_schema.profile_operate_password_reset)
const operate_phone_resolver = zodResolver(form_schema.profile_operate_phone_change.superRefine(({ new_phone }, ctx) => {
  if (new_phone === profile.value?.phone) {
    ctx.addIssue({
      code: 'custom',
      message: '如改！',
      path: ['new_phone'],
    })
  }
}))
const phone_resolver_with_old = zodResolver(form_schema.profile_change_phone.superRefine(({ new_phone }, ctx) => {
  if (new_phone === profile.value?.phone) {
    ctx.addIssue({
      code: 'custom',
      message: '如改！',
      path: ['new_phone'],
    })
  }
}))

const birthday_form_default = computed(() => {
  if (! profile.value) {
    return form_default.profile_birthday_update
  }

  return {
    birthday: profile.value.birthday ? dayjs.utc(profile.value.birthday).toISOString() : null,
  }
})

const reactive_date_now = useReactiveDateNow()

function build_date_budget_text(item: ProfileMetaItem) {
  const normal = item.value_date!.isBefore(reactive_date_now.value)

  if (item.key === 'birthday' && ! normal) {
    return duration_build_string([item.value_date!, reactive_date_now.value], '还有{formated}重生🪽', { just_now: '几十秒' })
  }
  else if (item.date_template) {
    return duration_build_string([item.value_date!, reactive_date_now.value], item.date_template)
  }
  return null
}

interface ProfileMetaItem {
  key: string
  label: string
  value?: string
  type?: 'text' | 'date'
  value_date?: Dayjs
  date_template?: string | [string, string]
  icon: string
}

const profile_meta_items = computed(() => {
  if (! profile.value) {
    return []
  }

  return [
    {
      key: 'created_at',
      label: '注册时间',
      type: 'date',
      value_date: localize_date(profile.value.created_at),
      date_template: ['已成为蠢猪{formated}', '刚刚成为蠢猪'],
      icon: 'lucide:user-round-check',
    },
    ... (profile.value.last_seen_at
      ? [{
          key: 'last_seen_at',
          label: '最近活跃',
          type: 'date',
          value: profile.value.last_seen_at,
          value_date: localize_date(profile.value.last_seen_at),
          date_template: ['{formated}前', '刚刚'],
          icon: 'lucide:person-standing',
        }]
      : []),
    ... (profile.value.editable
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
      value_date: profile.value.birthday ? localize_date(profile.value.birthday) : undefined,
      date_template: '{Y} 岁',
      icon: 'lucide:cake',
    },
  ] as ProfileMetaItem[]
})

type SessionFilter = 'valid' | 'expired'

const session_filter_options: { label: string, value: SessionFilter, icon: string }[] = [
  { label: '有效', value: 'valid', icon: 'lucide:circle-check' },
  { label: '已过期', value: 'expired', icon: 'lucide:hourglass' },
]

const session_filter = ref<SessionFilter>('valid')

const self_session_records = computed(() => {
  const records = self_sessions.value?.records ?? []
  return records.filter(record => session_filter.value === 'expired' ? record.is_expired : ! record.is_expired)
})

function open_birthday_editor() {
  birthday_editor_visible.value = true
}

function scroll_to_phone_form() {
  scroll_to(phone_form_section.value?.el)
}

function confirm_delete_avatar(event: Event) {
  confirm_require(event, '确定要删除头像吗？', delete_avatar)
}

function confirm_force_logout_session(event: Event, id: number, is_current: boolean) {
  confirm_require(event, '确定要强制退出该设备吗？', () => force_logout_self_session(id, is_current))
}

async function delete_avatar() {
  if (! profile.value) {
    return
  }

  avatar_delete_pending.value = true

  try {
    await profile_api.delete_avatar(is_operating_other.value ? profile.value.id : null)
    ok('头像已删除！')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    avatar_delete_pending.value = false
  }
}

async function force_logout_self_session(id: number, _is_current: boolean) {
  self_session_pending_id.value = id

  try {
    if (is_operating_other.value && profile.value) {
      await profile_api.force_logout_user_session(profile.value.id, id)
      ok('设备已退出登录状态')
      return
    }

    await profile_api.force_logout_session(id)

    ok('设备已退出登录状态')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    self_session_pending_id.value = null
  }
}

function session_status_text(record: SessionRecord) {
  if (record.is_logged_out) {
    return '已退出'
  }
  if (record.is_expired) {
    return '已过期'
  }
  return record.is_online ? '在线' : '离线'
}

function session_status_severity(record: SessionRecord) {
  if (! record.is_logged_out && record.is_online) {
    return 'success'
  }
  return 'info'
}

async function fetch_profile() {
  const id = Number(route.params.id)
  if (! Number.isInteger(id) || id <= 0) {
    throw new Error('？？？')
  }
  return await profile_api.get_profile(id)
}

const profile_sync_resource = computed(() => {
  const id = Number(route.params.id)
  return Number.isInteger(id) && id > 0 ? sync_resource('profile', id) : null
})

async function fetch_self_sessions() {
  if (is_operating_other.value && profile.value) {
    return await profile_api.get_user_sessions(profile.value.id)
  }
  return await profile_api.get_my_sessions()
}

const self_sessions_sync_resource = computed(() => {
  if (profile.value?.editable) {
    return sync_resource('profile_sessions', profile.value.id)
  }
  return null
})

await useSyncedData<Profile>(
  profile_sync_resource,
  fetch_profile,
  profile,
  sync_loading,
  {
    throw_resource_null_error: true,
    polling_interval: runtime_config.public.poll_interval_seconds * 1000,
  },
)

await useSyncedData<SessionOverview>(
  self_sessions_sync_resource,
  fetch_self_sessions,
  self_sessions,
  self_sessions_loading,
  {
    throw_resource_null_error: false,
    polling_interval: runtime_config.public.poll_interval_seconds * 1000,
  },
)

async function on_submit_birthday(event: FormSubmitEvent) {
  if (! event.valid) {
    return
  }

  const values = form_schema.profile_birthday_update.parse(event.values)
  birthday_pending.value = true

  try {
    await profile_api.update_birthday(
      values.birthday,
      is_operating_other.value && profile.value ? profile.value.id : null,
    )

    birthday_editor_visible.value = false
    ok('生日更新成功！')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    birthday_pending.value = false
  }
}

async function on_submit_operate_password(event: FormSubmitEvent) {
  if (! event.valid || ! profile.value) {
    return
  }

  const values = form_schema.profile_operate_password_reset.parse(event.values)
  operate_password_pending.value = true

  try {
    await profile_api.reset_password_for(profile.value.id, values)

    operate_password_form.value?.reset()
    ok('密码已修改！')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    operate_password_pending.value = false
  }
}

async function on_submit_operate_phone(event: FormSubmitEvent) {
  if (! event.valid || ! profile.value) {
    return
  }

  const values = form_schema.profile_operate_phone_change.parse(event.values)
  operate_phone_pending.value = true

  try {
    await profile_api.change_phone_for(profile.value.id, values.new_phone)

    operate_phone_form.value?.reset()
    ok('手机号已更换！')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    operate_phone_pending.value = false
  }
}

async function on_submit_password(event: FormSubmitEvent) {
  if (! event.valid) {
    return
  }

  const values = form_schema.profile_change_password.parse(event.values)
  password_pending.value = true

  try {
    const captcha = await captcha_verify()

    await profile_api.change_password({
      ... values,
      ... captcha,
    })

    password_form.value?.reset()
    ok('密码修改成功！')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    password_pending.value = false
  }
}

async function send_password_change_otp() {
  otp_sending.value = true

  try {
    const captcha = await captcha_verify()

    await auth_api.send_otp({ purpose: 'change_password', ... captcha })

    ok('验证码已发送！')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    otp_sending.value = false
  }
}

async function on_submit_password_by_otp(event: FormSubmitEvent) {
  if (! event.valid) {
    return
  }

  const values = form_schema.profile_change_password_by_otp.parse(event.values)
  password_otp_pending.value = true

  try {
    const captcha = await captcha_verify()

    await profile_api.change_password_by_otp({
      ... values,
      ... captcha,
    })

    password_otp_form.value?.reset()
    ok('密码修改成功！')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    password_otp_pending.value = false
  }
}

async function send_old_phone_otp() {
  old_phone_otp_sending.value = true

  try {
    const captcha = await captcha_verify()

    await auth_api.send_otp({ purpose: 'verify_old_phone', ... captcha })

    ok('验证码已发送！')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    old_phone_otp_sending.value = false
  }
}

async function send_new_phone_otp() {
  new_phone_otp_sending.value = true

  try {
    const captcha = await captcha_verify()

    await auth_api.send_otp({ phone: new_phone.value, purpose: 'change_phone', ... captcha })

    ok('验证码已发送！')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    new_phone_otp_sending.value = false
  }
}

async function submit_change_phone(event: FormSubmitEvent) {
  if (! event.valid) {
    return
  }

  const values = form_schema.profile_change_phone.parse(event.values)
  phone_change_pending.value = true

  try {
    const captcha = await captcha_verify()

    await profile_api.change_phone({
      ... values,
      ... captcha,
    })

    phone_form.value?.reset()
    ok('手机号已更换！')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    phone_change_pending.value = false
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
