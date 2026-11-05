<template>
  <MyHeightSection tag="section" class="section-card-collapse">
    <h2 class="mb-6">
      修改密码
    </h2>

    <div v-if="isOperatingOther">
      <Form ref="operate_password_form" :resolver="operate_password_resolver" :initial-values="form_default.profile_operate_password_reset" :validate-on-value-update="true" :validate-on-blur="true" @submit="submit_operated_password">
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

    <Form v-else-if="password_mode === 'old'" key="password-old" ref="password_form" :resolver="password_resolver" :initial-values="form_default.profile_change_password" :validate-on-value-update="true" :validate-on-blur="true" @submit="submit_password">
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

    <Form v-else key="password-otp" ref="password_otp_form" :resolver="password_otp_resolver" :initial-values="form_default.profile_change_password_by_otp" :validate-on-value-update="true" :validate-on-blur="true" @submit="submit_password_by_otp">
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
  </MyHeightSection>

  <MyHeightSection ref="phone_form_section" tag="section" class="section-card-collapse">
    <h2 class="mb-6">
      更换手机号
    </h2>

    <Form v-if="isOperatingOther" ref="operate_phone_form" :resolver="operate_phone_resolver" :initial-values="form_default.profile_operate_phone_change" :validate-on-value-update="true" :validate-on-blur="true" @submit="submit_operated_phone">
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

    <Form v-else ref="phone_form" :resolver="phone_resolver" :initial-values="form_default.profile_change_phone" :validate-on-value-update="true" :validate-on-blur="true" @submit="submit_phone_change">
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
</template>

<script setup lang="ts">
import type { FormInstance, FormSubmitEvent } from '@primevue/forms'
import type { Profile } from '@shared/types/user'
import { Form } from '@primevue/forms'
import { zodResolver } from '@primevue/forms/resolvers/zod'
import { form_default, form_schema } from '@shared/schemas'
import { useAccountSecurity } from '~/features/account/profile'

const props = defineProps<{
  profile: Profile
  isOperatingOther: boolean
}>()
const profile = toRef(props, 'profile')
const {
  password_pending,
  password_otp_pending,
  operate_password_pending,
  operate_phone_pending,
  phone_change_pending,
  reset_password_for,
  change_phone_for,
  change_password,
  change_password_by_otp,
  change_phone,
  send_otp,
} = useAccountSecurity(profile)
const { info } = useMyToast()
const password_mode = ref<'old' | 'otp'>('old')
const password_form = ref<FormInstance>()
const password_otp_form = ref<FormInstance>()
const operate_password_form = ref<FormInstance>()
const operate_phone_form = ref<FormInstance>()
const phone_form = ref<FormInstance>()
const phone_form_section = ref<{ el: HTMLElement | null } | null>(null)
const new_phone = computed(() => String(phone_form.value?.getFieldState('new_phone')?.value || ''))

const password_resolver = zodResolver(form_schema.profile_change_password)
const password_otp_resolver = zodResolver(form_schema.profile_change_password_by_otp)
const operate_password_resolver = zodResolver(form_schema.profile_operate_password_reset)
const operate_phone_resolver = zodResolver(form_schema.profile_operate_phone_change.superRefine(({ new_phone }, context) => {
  if (new_phone === profile.value.phone) {
    context.addIssue({ code: 'custom', message: '如改！', path: ['new_phone'] })
  }
}))
const phone_resolver = zodResolver(form_schema.profile_change_phone.superRefine(({ new_phone }, context) => {
  if (new_phone === profile.value.phone) {
    context.addIssue({ code: 'custom', message: '如改！', path: ['new_phone'] })
  }
}))

function scroll_to_phone_form() {
  scroll_to(phone_form_section.value?.el)
}

async function submit_operated_password(event: FormSubmitEvent) {
  if (event.valid && await reset_password_for(form_schema.profile_operate_password_reset.parse(event.values))) {
    operate_password_form.value?.reset()
  }
}

async function submit_operated_phone(event: FormSubmitEvent) {
  if (event.valid && await change_phone_for(form_schema.profile_operate_phone_change.parse(event.values))) {
    operate_phone_form.value?.reset()
  }
}

async function submit_password(event: FormSubmitEvent) {
  if (event.valid && await change_password(form_schema.profile_change_password.parse(event.values))) {
    password_form.value?.reset()
  }
}

async function submit_password_by_otp(event: FormSubmitEvent) {
  if (event.valid && await change_password_by_otp(form_schema.profile_change_password_by_otp.parse(event.values))) {
    password_otp_form.value?.reset()
  }
}

async function send_password_change_otp() {
  await send_otp('change_password')
}

async function send_old_phone_otp() {
  await send_otp('verify_old_phone')
}

async function send_new_phone_otp() {
  await send_otp('change_phone', new_phone.value)
}

async function submit_phone_change(event: FormSubmitEvent) {
  if (event.valid && await change_phone(form_schema.profile_change_phone.parse(event.values))) {
    phone_form.value?.reset()
  }
}

defineExpose({ scroll_to_phone_form })
</script>
