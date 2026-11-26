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
      <MyInputOtp :id="id" v-model="$field.value" class="min-w-0" :placeholder="placeholder" :aria-describedby="described_by" v-bind="{ ... extra, ... $field.props, invalid: $field.invalid }" />
      <MyOtpButton
        v-if="otpSend"
        v-model="otp_cooldown_until"
        class="otp-send-button shrink-0 whitespace-nowrap !text-sm"
        :loading="otp_btn_loading"
        @click="on_otp_send"
      />
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
import { phone_schema } from '@shared/schemas'
import { useApi } from '~/composables/useApi'
import { invalidate_shared_queries } from '~/composables/useSyncedData'

interface OtpChannels { phone: string | null, identity: string | null }
interface OtpCooldownSnapshot { until: string | null, channels: OtpChannels | null }

interface MyFormFieldOtpSendOptions {
  sendHandler: () => Promise<void>
  targetPhone: string
  targetFieldName?: string
  purpose: 'register' | 'login' | 'change_password' | 'verify_old_phone' | 'change_phone'
}

const props = withDefaults(defineProps<{
  name: string
  inputId?: string
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

const id = computed(() => props.inputId ?? `field-${props.name}`)
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
const nuxt_app = useNuxtApp()
const pc_form = inject<useFormReturn | undefined>('$pcForm', undefined)

// Store a UTC ISO string rather than Dayjs so the cooldown survives payload serialization.
const otp_state_key = props.otpSend ? `${props.otpSend.purpose}:${props.name}` : props.name
const otp_cooldown_until = useSyncedState<string | null>(`otp_cooldown_${otp_state_key}`, () => null)
const otp_send_loading = ref(false)
const otp_sync_loading = useState(`otp_cooldown_loading_${otp_state_key}`, () => false)
const otp_query_key_prefix = 'otp-cooldown:'

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
    // A send can reserve a device-wide cooldown even when SMS fails or MQTT
    // misses the update. Recheck each target through its own shared query.
    await invalidate_shared_queries(nuxt_app, otp_query_key_prefix)
    otp_send_loading.value = false
  }
}

if (props.otpSend) {
  // THIS IS A GOOD COMMENT BEGIN
  // POV: Great material for testing AI's coding capability in fixing such weird bugs.
  /**
   * [Possible prompt]
   * fix an existing bug. steps to reproduce:
   * 1. click "发送" in "旧手机号验证码" field.
   * 2. click the switch mode button to show "手机验证码" field in "修改密码" section.
   * 3. click "发送" in the newly showed "手机验证码" field.
   * 4. observe the "发送" button in "旧手机号验证码" field is NOT disabled and NOT counting down as expected.
   */
  // THIS IS A GOOD COMMENT END

  const otp_target_phone = computed(() => {
    const phone = props.otpSend!.targetPhone
    return phone_schema.safeParse(phone).success ? phone : null
  })

  // Cooldown channels are keyed server-side; the browser cannot derive them,
  // so the subscription sources follow whatever the last query returned.
  const otp_channels = ref<OtpChannels>({ phone: null, identity: null })

  // Channels travel with the result so a superseded response cannot replace them.
  async function sync_otp_cooldown(): Promise<OtpCooldownSnapshot> {
    const target_phone = otp_target_phone.value

    if (! target_phone) {
      return { until: null, channels: null }
    }

    try {
      const data = await auth_api.get_otp_cooldown({ phone: target_phone })
      return { until: data?.next_available_at ?? null, channels: data?.channels ?? null }
    }
    catch {
      return { until: null, channels: null }
    }
  }

  const otp_cooldown_snapshot = useSyncedState(computed<OtpCooldownSnapshot | null>({
    get: () => ({ until: otp_cooldown_until.value, channels: null }),
    set: (snapshot) => {
      otp_cooldown_until.value = snapshot?.until ?? null
      if (snapshot?.channels) {
        otp_channels.value = snapshot.channels
      }
    },
  }))

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

  const otp_sync_ready = computed(() => ! otp_sync_source_has_error.value && !! otp_target_phone.value)
  const otp_sync_source = computed(() => otp_sync_ready.value ? otp_channels.value.phone : null)
  const otp_sync_by_identity_source = computed(() => otp_sync_ready.value ? otp_channels.value.identity : null)

  await useSyncedData<OtpCooldownSnapshot>(
    [otp_sync_source, otp_sync_by_identity_source],
    sync_otp_cooldown,
    otp_cooldown_snapshot,
    otp_sync_loading,
    // The query key is the typed phone, not the channels: it exists before the
    // first fetch (so the initial query can run with no channel known yet),
    // a phone change re-fetches exactly once, and channel updates arriving
    // with the data only re-subscribe without fetching again.
    { query_key: computed(() => otp_target_phone.value ? `${otp_query_key_prefix}${otp_target_phone.value}` : null) },
  )

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

<style scoped>
.p-inputgroup > .otp-send-button.p-button {
  /* The input already draws the shared edge. */
  border-inline-start-width: 0;
}
</style>
