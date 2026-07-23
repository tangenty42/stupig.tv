<template>
  <!--
    I'm a real "stupig".
    Previously, v-ifs below are like:
      <component v-if="as === 'InputOtp'" ...
    It does work well on browsers. In fact, you can invoke a prop without any `props.` prefix. No problem.
    But for code highlighting, it's a different story. It crashes.
    I asked Kimi, it investigated deeply, did tests itself, even offer to raise an issue...
    At first, I was so excited to see how awesome Kimi is, despite my crying wallet.
    With satisfaction, I then tried to do a minimal reproduction personally.
    But I just couldn't make it work.
    After handful of tries,
    Minutes, quarters, hours,
    ...
    ...
    ...
    "Fuck!!!"
    "`as` alone is a reserved word in TypeScript!"
  -->

  <FormField v-slot="$field" :name="name" as="div">
    <div class="form-label flex flex-wrap items-center gap-3">
      <label :for="id">{{ label }}</label>
      <span v-if="hint" :id="hint_id" class="muted">{{ hint }}</span>
    </div>

    <component :is="otpSend ? 'InputGroup' : 'div'" v-if="props.as === 'InputOtp'">
      <MyInputOtp :id="id" v-model="$field.value" :placeholder="placeholder" :aria-describedby="described_by" v-bind="{ ... extra, ... $field.props, invalid: $field.invalid }" />
      <InputGroupAddon v-if="otpSend" class="shrink-0 px-6">
        <MyOtpButton
          v-model="otp_cooldown_until"
          class="text-sm h-full"
          :loading="otp_btn_loading"
          @click="on_otp_send"
        />
      </InputGroupAddon>
    </component>
    <IconField v-else-if="props.as === 'Password'">
      <InputIcon><MyIcon name="lucide:key" /></InputIcon>
      <Password :input-id="id" :feedback="false" toggle-mask fluid :placeholder="placeholder" :autocomplete="autocomplete" v-bind="{ ... $field.props, ... extra }" :aria-describedby="described_by" @paste="on_paste">
        <template #maskicon="{ toggleCallback }">
          <MyIcon name="lucide:eye" class="p-password-toggle-mask-icon p-password-unmask-icon" @click="toggleCallback" />
        </template>
        <template #unmaskicon="{ toggleCallback }">
          <MyIcon name="lucide:eye-off" class="p-password-toggle-mask-icon p-password-unmask-icon" @click="toggleCallback" />
        </template>
      </Password>
    </IconField>
    <!--
      I was like having had a ton of sh*t to do with the PrimeVue's DatePicker.
      reference:  https://github.com/primefaces/primevue/issues/7569
                  https://github.com/primefaces/primevue/issues/7515
      Now `inline` is set. You win, PrimeTek.
      Hopefully I give in before I throw this to Kimi K3.
      Or I may have to take out some loan to get a plan upgrade.
    -->
    <DatePicker v-else-if="props.as === 'DatePicker'" v-model="$field.value" show-button-bar :input-id="id" inline update-model-type="date" fluid :placeholder="placeholder" :autocomplete="autocomplete" v-bind="{ ... extra, ... $field.props }" :aria-describedby="described_by">
      <template #buttonbar="{ clearCallback }">
        <div class="w-full flex justify-end">
          <span v-if="$field.value === null" class="me-2 text-sm text-muted-color">
            暂未选择哦！
          </span>
          <Button v-else size="small" severity="danger" variant="text" label="清除" @click="clearCallback" />
        </div>
      </template>
    </DatePicker>
    <IconField v-else-if="props.as === 'Phone'">
      <InputIcon><MyIcon name="lucide:phone" /></InputIcon>
      <InputText :id="id" v-model="$field.value" type="tel" maxlength="11" inputmode="numeric" fluid :placeholder="placeholder" :autocomplete="autocomplete" v-bind="{ ... extra, ... $field.props }" :aria-describedby="described_by" />
    </IconField>
    <div v-else-if="props.as === 'ToggleSwitch'" class="flex min-h-11 items-center">
      <ToggleSwitch v-model="$field.value" :input-id="id" v-bind="{ ... extra, ... $field.props }" :aria-describedby="described_by" />
    </div>
    <component :is="icon ? 'IconField' : 'div'" v-else-if="props.as === 'Textarea'">
      <InputIcon v-if="icon">
        <MyIcon :name="icon" />
      </InputIcon>
      <Textarea :id="id" auto-resize fluid :placeholder="placeholder" :autocomplete="autocomplete" v-bind="{ ... extra, ... $field.props }" :aria-describedby="described_by" />
    </component>
    <component :is="icon ? 'IconField' : 'div'" v-else>
      <InputIcon v-if="icon">
        <MyIcon :name="icon" />
      </InputIcon>
      <InputText :id="id" fluid :placeholder="placeholder" :autocomplete="autocomplete" v-bind="{ ... extra, ... $field.props }" :aria-describedby="described_by" />
    </component>

    <div v-if="$field.invalid" :id="error_id" class="form-error">
      {{ $field.error?.message }}
    </div>
  </FormField>
</template>

<script lang="ts" setup>
import type { useFormReturn } from '@primevue/forms/useform'
import { FormField } from '@primevue/forms'
import { sync_resource } from '@shared/types/sync'
import { phone_schema } from '@shared/validate'
import { useApi } from '~/composables/useApi'

interface MyFormFieldOtpSendOptions {
  sendHandler: () => Promise<void>
  targetPhone: string
  targetFieldName?: string
  purpose: 'register' | 'login' | 'change_password' | 'verify_old_phone' | 'change_phone'
}

const props = withDefaults(defineProps<{
  name: string
  label?: string
  icon?: string
  placeholder?: string
  hint?: string
  as?: 'InputText' | 'Phone' | 'Password' | 'InputOtp' | 'DatePicker' | 'Textarea' | 'ToggleSwitch'
  autocomplete?: string
  extra?: Record<string, any>
  noPaste?: boolean
  otpSend?: Readonly<MyFormFieldOtpSendOptions>
}>(), {
  as: 'InputText',
})

const { error } = useMyToast()

const id = computed(() => `field-${props.name}`)
const hint_id = computed(() => `${id.value}-hint`)
const error_id = computed(() => `${id.value}-error`)
const described_by = computed(() => {
  const ids: string[] = []
  if (props.hint)
    ids.push(hint_id.value)
  // FormField's $field.props may include aria-describedby; merge below via v-bind order
  return ids.length ? ids.join(' ') : undefined
})

const { auth: auth_api } = useApi()
const pc_form = inject<useFormReturn | undefined>('$pcForm', undefined)

// Stored as a plain UTC ISO string (not Dayjs) so the value survives Nuxt
// payload serialization between SSR and hydration intact. Consumers
// localize it at the point of use.
const otp_cooldown_until = ref<string | null>(null)
const otp_send_loading = ref(false)
const otp_sync_loading = ref(false)

const { public: config } = useRuntimeConfig()
const identity_token = useCookie(config.identity_cookie_name)

async function target_field_has_error() {
  const field_name = props.otpSend?.targetFieldName

  if (! field_name || ! pc_form) {
    return false
  }

  const validate_result = await pc_form.validate(field_name) as {
    errors: Record<string, string[]>
  }
  const has_error = (validate_result.errors?.[field_name]?.length ?? 0) > 0
  if (has_error) {
    error('请检查手机号！错了万姐让你罚抄100遍！')
  }

  return has_error
}

async function on_otp_send() {
  if (! props.otpSend?.sendHandler || await target_field_has_error()) {
    return
  }
  try {
    otp_send_loading.value = true
    await props.otpSend.sendHandler()
  }
  finally {
    otp_send_loading.value = false
  }
}

if (props.otpSend) {
  const otp_target_phone = computed(() => {
    const phone = props.otpSend !.targetPhone.trim()
    return phone_schema.safeParse(phone).success ? phone : null
  })

  async function sync_otp_cooldown() {
    const target_phone = otp_target_phone.value

    if (! target_phone) {
      return null
    }

    try {
      const data = await auth_api.get_otp_cooldown({ phone: target_phone, purpose: props.otpSend !.purpose })

      const next_available_at = data?.next_available_at
      if (! next_available_at) {
        return null
      }

      return next_available_at
    }
    catch {
      return null
    }
  }

  const otp_sync_source_has_error = ref(false)

  watch(() => otp_target_phone.value, async (new_phone) => {
    if (! new_phone) {
      otp_sync_source_has_error.value = true
      return
    }

    const start_phone = new_phone
    const has_error = await target_field_has_error()

    // Only apply if the phone hasn't changed during validation
    if (otp_target_phone.value === start_phone) {
      otp_sync_source_has_error.value = has_error
    }
  }, { immediate: true, flush: 'sync' })

  const otp_sync_source = computed(() => {
    if (otp_sync_source_has_error.value || otp_target_phone.value === null) {
      return null
    }

    return sync_resource('otp_cooldown', otp_target_phone.value)
  })

  await useSyncedData<string | null>(
    otp_sync_source,
    sync_otp_cooldown,
    otp_cooldown_until,
    otp_sync_loading,
  )
  if (identity_token.value) {
    await useSyncedData<string | null>(
      computed(() => sync_resource('otp_cooldown_by_identity', identity_token.value !)),
      sync_otp_cooldown,
      otp_cooldown_until,
      otp_sync_loading,
      { immediate: false },
    )
  }

  watch(otp_sync_source_has_error, (new_val) => {
    if (new_val) {
      otp_cooldown_until.value = null
    }
  }, { immediate: true })
}

const otp_btn_loading = computed(() => otp_send_loading.value || otp_sync_loading.value)

function on_paste(e: Event) {
  if (props.noPaste) {
    e.preventDefault()
  }
}
</script>
