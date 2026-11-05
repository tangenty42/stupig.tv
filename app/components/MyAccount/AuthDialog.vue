<template>
  <MyDialog
    v-model:visible="visible"
    :pending="auth.locked.value"
    :draggable="false"
    class="w-full max-w-[32rem]"
  >
    <template #header>
      <div class="flex items-center gap-3">
        <img class="h-10 w-auto dark:invert" :src="static_url('/imgs/Stupig_regular.svg')" alt="Stupig Logo">
        <div>
          <p class="text-lg font-semibold">
            登录 / 注册
          </p>
          <p class="text-sm text-slate-500 dark:text-slate-400">
            忘账号密码者，皆蠢猪耶？
          </p>
        </div>
      </div>
    </template>

    <Tabs v-model:value="mode">
      <TabList>
        <Tab value="login">
          <MyIcon name="lucide:user-check" class="me-1" />
          登录
        </Tab>
        <Tab value="register">
          <MyIcon name="lucide:circle-plus" class="me-1" />
          注册
        </Tab>
      </TabList>

      <TabPanels>
        <TabPanel value="login">
          <div class="mt-8">
            <SelectButton
              v-model="login_method"
              :options="login_method_options"
              option-label="label"
              option-value="value"
              :allow-empty="false"
              class="pt-1"
              fluid
              size="small"
            />

            <Transition name="fade-down" mode="out-in">
              <KeepAlive>
                <Form
                  v-if="login_method === 'password'"
                  id="login-password-form"
                  key="login-password"
                  ref="password_login_form"
                  :resolver="password_login_resolver"
                  :initial-values="form_default.login_with_password"
                  :validate-on-value-update="true"
                  :validate-on-blur="true"
                  @submit="submit_password_login"
                >
                  <div class="grid gap-4 pt-6">
                    <MyFormField v-for="field in password_login_fields" :key="field.name" v-bind="field" />
                  </div>
                </Form>

                <Form
                  v-else
                  id="login-phone-form"
                  key="login-phone"
                  ref="phone_login_form"
                  :resolver="phone_login_resolver"
                  :initial-values="form_default.login_with_phone"
                  :validate-on-value-update="true"
                  :validate-on-blur="true"
                  @submit="submit_phone_login"
                >
                  <div class="grid gap-4 pt-6">
                    <MyFormField v-for="field in phone_login_fields" :key="field.name" v-bind="field" />

                    <MyFormField
                      name="otp"
                      as="InputOtp"
                      label="手机验证码"
                      :otp-send="{ sendHandler: () => send_otp('login'), targetPhone: login_phone, targetFieldName: 'phone', purpose: 'login' }"
                    />
                  </div>
                </Form>
              </KeepAlive>
            </Transition>
          </div>
        </TabPanel>

        <TabPanel value="register">
          <KeepAlive>
            <Form
              id="register-form"
              key="register"
              ref="register_form"
              :resolver="register_resolver"
              :initial-values="form_default.register"
              :validate-on-value-update="true"
              :validate-on-blur="true"
              @submit="submit_register"
            >
              <div class="grid gap-4 pt-2">
                <MyFormField v-for="field in register_fields_top" :key="field.name" v-bind="field" />

                <MyFormField
                  name="otp"
                  as="InputOtp"
                  label="手机验证码"
                  :otp-send="{ sendHandler: () => send_otp('register'), targetPhone: register_phone, targetFieldName: 'phone', purpose: 'register' }"
                />

                <MyFormField v-for="field in register_fields_bottom" :key="field.name" v-bind="field" />
              </div>
            </Form>
          </KeepAlive>
        </TabPanel>
      </TabPanels>
    </Tabs>

    <template #footer>
      <Transition name="fade-down" mode="out-in">
        <!-- eslint-disable-next-line vue/require-toggle-inside-transition -- toggle is on the nested divs -->
        <div class="mt-4">
          <div v-if="mode === 'login'" key="login" class="flex gap-2">
            <Button
              type="submit"
              :form="login_method === 'password' ? 'login-password-form' : 'login-phone-form'"
              label="立即登录"
              :loading="auth.pending.value"
              :disabled="auth.pending.value"
            >
              <template #icon>
                <MyIcon name="lucide:check" />
              </template>
            </Button>
          </div>
          <div v-else key="register" class="flex gap-2">
            <Button type="submit" form="register-form" label="立即注册" :loading="auth.pending.value" :disabled="auth.pending.value">
              <template #icon>
                <MyIcon name="lucide:check" />
              </template>
            </Button>
          </div>
        </div>
      </Transition>
    </template>
  </MyDialog>
</template>

<script setup lang="ts">
import type { FormInstance, FormSubmitEvent } from '@primevue/forms'
import { Form } from '@primevue/forms'
import { zodResolver } from '@primevue/forms/resolvers/zod'
import { form_default, form_schema } from '@shared/schemas'
import { useAccountAuthFlow } from '~/features/account/auth'

const visible = defineModel<boolean>('visible', { default: false })
const static_url = useStaticUrl()
const auth = useAccountAuthFlow()
const mode = ref<'login' | 'register'>('login')
const login_method = ref<'password' | 'phone'>('password')

const password_login_resolver = zodResolver(form_schema.login_with_password)
const phone_login_resolver = zodResolver(form_schema.login_with_phone)
const register_resolver = zodResolver(form_schema.register)

const password_login_fields = [
  { name: 'username_or_phone', label: '用户名 / 手机号', icon: 'lucide:user', autocomplete: 'username' },
  { name: 'password', label: '密码', as: 'Password' as const, autocomplete: 'current-password' },
]
const phone_login_fields = [
  { name: 'phone', label: '手机号', as: 'Phone' as const, autocomplete: 'tel' },
]
const register_fields_top = [
  { name: 'username', label: '用户名', icon: 'lucide:user', autocomplete: 'username' },
  { name: 'phone', label: '手机号', as: 'Phone' as const, autocomplete: 'tel' },
]
const register_fields_bottom = [
  { name: 'password', label: '密码', as: 'Password' as const, autocomplete: 'new-password' },
  { name: 'confirm_password', label: '确认密码', as: 'Password' as const, autocomplete: 'new-password', noPaste: true },
]
const login_method_options = [
  { label: '密码登录', value: 'password' },
  { label: '手机验证码登录', value: 'phone' },
]

const password_login_form = ref<FormInstance>()
const phone_login_form = ref<FormInstance>()
const register_form = ref<FormInstance>()
const login_phone = computed(() => String(phone_login_form.value?.getFieldState('phone')?.value || ''))
const register_phone = computed(() => String(register_form.value?.getFieldState('phone')?.value || ''))

watch(visible, (is_visible) => {
  if (! is_visible) {
    password_login_form.value?.reset()
    phone_login_form.value?.reset()
    register_form.value?.reset()
  }
})

async function send_otp(target: 'login' | 'register') {
  await auth.send_otp(target === 'login' ? login_phone.value : register_phone.value, target)
}

async function submit_password_login(event: FormSubmitEvent) {
  if (event.valid && await auth.login_with_password(form_schema.login_with_password.parse(event.values))) {
    visible.value = false
  }
}

async function submit_phone_login(event: FormSubmitEvent) {
  if (event.valid && await auth.login_with_phone(form_schema.login_with_phone.parse(event.values))) {
    visible.value = false
  }
}

async function submit_register(event: FormSubmitEvent) {
  if (event.valid && await auth.register(form_schema.register.parse(event.values))) {
    visible.value = false
  }
}
</script>
