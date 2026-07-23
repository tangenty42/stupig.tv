<template>
  <div class="min-h-screen overflow-x-clip">
    <Toast position="center" />

    <header
      class="fixed inset-x-0 top-0 z-50 isolate transition-all duration-200 before:pointer-events-none before:absolute before:inset-0 before:opacity-0 before:backdrop-blur-[16px] before:transition-opacity before:duration-200"
      :class="scrolled ? 'border-b border-slate-200 bg-white/80 shadow-sm dark:border-slate-700 dark:bg-gray-900/80 before:opacity-100' : 'border-b border-transparent bg-transparent'"
    >
      <div class="relative z-10 mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <NuxtLink class="transition-all duration-300 hover:blur-[1px] active:blur-[1px]" to="/">
          <img class="h-10 w-auto dark:hidden" :src="static_url('/imgs/Stupig_fancy.svg')" alt="Stupig Logo">
          <img class="hidden h-10 w-auto dark:block" :src="static_url('/imgs/Stupig_fancy_light.svg')" alt="Stupig Logo">
        </NuxtLink>

        <div class="flex items-center gap-2">
          <Button aria-label="切换浅色 / 深色模式" text rounded severity="secondary" @click="toggle_color_mode">
            <template #icon>
              <MyIcon :name="my_color_mode === 'dark' ? 'lucide:sun' : 'lucide:moon'" />
            </template>
          </Button>
          <MyProfileHoverCard v-if="!!user" :profile="user" @logout="logout" />
          <Button v-else label="登录 / 注册" size="small" severity="secondary" outlined :raised="!scrolled" @click="lor_modal = true">
            <template #icon>
              <MyIcon name="lucide:user" />
            </template>
          </Button>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-5xl px-4 pt-24">
      <NuxtPage />
    </main>

    <MyDialog
      v-model:visible="lor_modal"
      :pending="dialog_locked"
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

      <Tabs v-model:value="lor">
        <TabList>
          <Tab value="login">
            <MyIcon name="lucide:user-check" class="me-1 align-middle" />
            登录
          </Tab>
          <Tab value="register">
            <MyIcon name="lucide:circle-plus" class="me-1 align-middle" />
            注册
          </Tab>
        </TabList>

        <TabPanels>
          <TabPanel value="login">
            <div class="mt-8">
              <SelectButton
                v-model="lor_login_with"
                :options="login_with_options"
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
                    v-if="lor_login_with === 'password'"
                    key="login-password"
                    ref="form_login_pwd"
                    :resolver="resolver_login_pwd"
                    :initial-values="form_default.login_with_password"
                    :validate-on-value-update="true"
                    :validate-on-blur="true"
                    @submit="on_submit_login_pwd"
                  >
                    <div class="grid gap-4 pt-6">
                      <MyFormField v-for="field in login_pwd_fields" :key="field.name" v-bind="field" />
                    </div>
                  </Form>

                  <Form
                    v-else
                    key="login-phone"
                    ref="form_login_phone"
                    :resolver="resolver_login_phone"
                    :initial-values="form_default.login_with_phone"
                    :validate-on-value-update="true"
                    :validate-on-blur="true"
                    @submit="on_submit_login_phone"
                  >
                    <div class="grid gap-4 pt-6">
                      <MyFormField v-for="field in login_phone_fields" :key="field.name" v-bind="field" />

                      <MyFormField

                        name="otp"
                        as="InputOtp"
                        label="手机验证码"
                        :otp-send="{ sendHandler: () => lor_send_otp('login'), targetPhone: login_otp_phone, targetFieldName: 'phone', purpose: 'login' }"
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
                key="register"
                ref="form_register"
                :resolver="resolver_register"
                :initial-values="form_default.register"
                :validate-on-value-update="true"
                :validate-on-blur="true"
                @submit="on_submit_register"
              >
                <div class="grid gap-4 pt-2">
                  <MyFormField v-for="field in register_fields_top" :key="field.name" v-bind="field" />

                  <MyFormField

                    name="otp"
                    as="InputOtp"
                    label="手机验证码"
                    :otp-send="{ sendHandler: () => lor_send_otp('register'), targetPhone: register_otp_phone, targetFieldName: 'phone', purpose: 'register' }"
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
            <div v-if="lor === 'login'" key="login" class="flex gap-2">
              <Button label="立即登录" :loading="lor_pending" :disabled="lor_pending" @click="submit_active_login_form">
                <template #icon>
                  <MyIcon name="lucide:check" />
                </template>
              </Button>
            </div>
            <div v-else key="register" class="flex gap-2">
              <Button label="立即注册" :loading="lor_pending" :disabled="lor_pending" @click="form_register?.submit()">
                <template #icon>
                  <MyIcon name="lucide:check" />
                </template>
              </Button>
            </div>
          </div>
        </Transition>
      </template>
    </MyDialog>
  </div>
</template>

<script lang="ts" setup>
import type { FormInstance, FormSubmitEvent } from '@primevue/forms'
import { Form } from '@primevue/forms'
import { zodResolver } from '@primevue/forms/resolvers/zod'
import { sync_resource } from '@shared/types/sync'
import { form_default, schema } from '@shared/validate'

const static_url = useStaticUrl()
const { error, ok, info } = useMyToast()
const { auth: auth_api, profile: profile_api } = useApi()
const { user, token, apply_auth, update_user, logout } = useAuth()
const { verify: captcha_verify, showing: captcha_showing } = useCaptcha()
const color_mode = useColorMode()
const my_color_mode = useMyColorMode()

const scrolled = ref(false)
function on_scroll() {
  scrolled.value = window.scrollY > 0
}
onMounted(() => {
  on_scroll()
  window.addEventListener('scroll', on_scroll, { passive: true })
})
onUnmounted(() => {
  window.removeEventListener('scroll', on_scroll)
})

const lor_modal = ref(false)
const lor = ref<'login' | 'register'>('login')
const lor_login_with = ref<'password' | 'phone'>('password')

const resolver_login_pwd = zodResolver(schema.login_with_password)
const resolver_login_phone = zodResolver(schema.login_with_phone)
const resolver_register = zodResolver(schema.register)

const login_pwd_fields = [
  { name: 'username_or_phone', label: '用户名 / 手机号', icon: 'lucide:user', autocomplete: 'username' },
  { name: 'password', label: '密码', as: 'Password' as const, autocomplete: 'current-password' },
]

const login_phone_fields = [
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

const login_with_options = [
  { label: '密码登录', value: 'password' },
  { label: '手机验证码登录', value: 'phone' },
]

const form_login_pwd = ref<FormInstance>()
const form_login_phone = ref<FormInstance>()
const form_register = ref<FormInstance>()

const lor_pending = ref(false)
const lor_otp_pending = ref(false)

const dialog_locked = computed(() => lor_pending.value || lor_otp_pending.value || captcha_showing.value)

const login_otp_phone = computed(() => form_login_phone.value?.getFieldState('phone')?.value || '')
const register_otp_phone = computed(() => form_register.value?.getFieldState('phone')?.value || '')

function toggle_color_mode() {
  color_mode.preference = color_mode.value === 'dark' ? 'light' : 'dark'
}

function submit_active_login_form() {
  if (lor_login_with.value === 'password') {
    form_login_pwd.value?.submit()
  }
  else {
    form_login_phone.value?.submit()
  }
}

async function sync_current_user() {
  if (! token.value) {
    return
  }

  const profile = await profile_api.get_me()

  update_user({
    id: profile.id,
    username: profile.username,
    phone: profile.phone || user.value?.phone || '',
    avatar_file: profile.avatar_file,
    is_verified: profile.is_verified,
    is_admin: profile.is_admin,
  })

  return profile
}

const auth_user_sync_resource = computed(() => {
  return user.value?.id ? sync_resource('auth_user', user.value.id) : null
})

await useSyncedData(
  auth_user_sync_resource,
  sync_current_user,
)

watch(lor_modal, (visible) => {
  if (! visible) {
    form_login_pwd.value?.reset()
    form_login_phone.value?.reset()
    form_register.value?.reset()
  }
})

async function lor_send_otp(target: 'login' | 'register') {
  let phone: string
  let purpose: 'login' | 'register'

  if (target === 'login') {
    phone = form_login_phone.value?.getFieldState('phone')?.value || ''
    purpose = 'login'
  }
  else {
    phone = form_register.value?.getFieldState('phone')?.value || ''
    purpose = 'register'
  }

  lor_otp_pending.value = true

  try {
    const captcha = await captcha_verify()

    await auth_api.send_otp({ phone, purpose, ...captcha })

    info('验证码发送成功！')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    lor_otp_pending.value = false
  }
}

async function on_submit_login_pwd(e: FormSubmitEvent) {
  if (! e.valid)
    return

  lor_pending.value = true

  try {
    const captcha = await captcha_verify()

    const data = await auth_api.login_with_password({
      username_or_phone: String(e.values.username_or_phone),
      password: String(e.values.password),
      ...captcha,
    })

    apply_auth(data)
    lor_modal.value = false
    ok('登录成功！')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    lor_pending.value = false
  }
}

async function on_submit_login_phone(e: FormSubmitEvent) {
  if (! e.valid)
    return

  lor_pending.value = true

  try {
    const captcha = await captcha_verify()

    const data = await auth_api.login_with_phone({
      phone: String(e.values.phone),
      otp: String(e.values.otp),
      ...captcha,
    })

    apply_auth(data)
    lor_modal.value = false
    ok('登录成功！')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    lor_pending.value = false
  }
}

async function on_submit_register(e: FormSubmitEvent) {
  if (! e.valid)
    return

  lor_pending.value = true

  try {
    const captcha = await captcha_verify()

    const data = await auth_api.register({ ...e.values, ...captcha })

    apply_auth(data)
    lor_modal.value = false
    ok('注册成功！欢迎新生小猪~')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    lor_pending.value = false
  }
}
</script>
