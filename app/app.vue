<template>
  <div class="min-h-screen overflow-x-clip" :style="header_height_var">
    <Toast position="center" />
    <ConfirmPopup>
      <template #message="{ message }">
        <div class="p-confirmpopup-content">
          <MyIcon name="lucide:triangle-alert" class="shrink-0 text-xl text-amber-500" />
          <span>{{ message.message }}</span>
        </div>
      </template>
    </ConfirmPopup>

    <header
      ref="app_header"
      class="fixed inset-x-0 top-0 z-50 isolate transition-all duration-200 before:pointer-events-none before:absolute before:inset-0 before:opacity-0 before:backdrop-blur-[16px] before:transition-opacity before:duration-200"
      :class="scrolled ? 'border-b border-slate-200 bg-white/80 shadow-sm dark:border-slate-700 dark:bg-gray-900/80 before:opacity-100' : 'border-b border-transparent bg-transparent'"
    >
      <div class="relative mx-auto max-w-5xl">
        <div
          class="relative z-20"
          :style="logo_spacer_style"
        />

        <Transition name="route-loading">
          <span
            v-if="route_loading"
            class="absolute left-3 top-[0.6rem] z-20 size-10"
            :style="indicator_shift_style"
          >
            <MyIcon name="lucide:loader-circle" class="size-10 animate-spin text-slate-400" />
          </span>
        </Transition>

        <NuxtLink
          class="absolute left-3 top-[0.6rem] z-20 transition-[filter] duration-300 hover:blur-[1px] active:blur-[1px]"
          :class="{ 'pointer-events-none': header_shift_progress === 1 }"
          :style="logo_style"
          to="/"
        >
          <img
            class="h-10 w-auto transition-opacity duration-200 dark:hidden"
            :class="{ 'opacity-30': route_loading }"
            :src="static_url('/imgs/Stupig_fancy.svg')"
            alt="Stupig Logo"
          >
          <img
            class="hidden h-10 w-auto transition-opacity duration-200 dark:block"
            :class="{ 'opacity-30': route_loading }"
            :src="static_url('/imgs/Stupig_fancy_light.svg')"
            alt="Stupig Logo"
          >
        </NuxtLink>

        <div class="absolute right-2 top-2 z-30 flex items-center gap-2">
          <Button aria-label="切换浅色 / 深色模式" text severity="secondary" @click="toggle_color_mode">
            <template #icon>
              <MyIcon :name="my_color_mode === 'dark' ? 'lucide:sun' : 'lucide:moon'" />
            </template>
          </Button>
          <MyProfileHoverCard v-if="!! user" :profile="user" @logout="logout" />
          <Button v-else label="登录 / 注册" size="small" severity="secondary" text @click="lor_modal = true">
            <template #icon>
              <MyIcon name="lucide:user" />
            </template>
          </Button>
        </div>

        <div
          class="breadcrumb-row relative z-10 flex items-center px-4 transition-opacity duration-200"
          :class="{ 'opacity-30': route_loading }"
          :style="breadcrumb_row_style"
        >
          <Breadcrumb :home="breadcrumb_home" :model="breadcrumb_items" class="!border-0 !bg-transparent !p-0">
            <template #item="{ item, props }">
              <NuxtLink v-if="item.route" v-slot="{ href, navigate }" :to="item.route" custom>
                <a :href="href || undefined" v-bind="props.action" class="text-xs" @click="navigate">
                  <MyIcon v-if="item.icon" :name="item.icon" />
                  <span>{{ item.label }}</span>
                </a>
              </NuxtLink>
              <span v-else v-bind="props.action" class="text-xs">{{ item.label }}</span>
            </template>
            <template #separator>
              <MyIcon name="lucide:chevron-right" class="text-xs text-slate-400" />
            </template>
          </Breadcrumb>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-5xl px-4 pt-36">
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
                    id="login-password-form"
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
                    id="login-phone-form"
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
                id="register-form"
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
              <Button
                type="submit"
                :form="lor_login_with === 'password' ? 'login-password-form' : 'login-phone-form'"
                label="立即登录"
                :loading="lor_pending"
                :disabled="lor_pending"
              >
                <template #icon>
                  <MyIcon name="lucide:check" />
                </template>
              </Button>
            </div>
            <div v-else key="register" class="flex gap-2">
              <Button type="submit" form="register-form" label="立即注册" :loading="lor_pending" :disabled="lor_pending">
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
import { form_default, form_schema } from '@shared/schemas'
import { sync_resource } from '@shared/types/sync'

const static_url = useStaticUrl()
const { error, ok, info, clear: clear_toasts } = useMyToast()
const { auth: auth_api, profile: profile_api } = useApi()
const { user, apply_auth, update_user, logout } = useAuth()
const { verify: captcha_verify, showing: captcha_showing } = useCaptcha()
const color_mode = useColorMode()
const my_color_mode = useMyColorMode()
const route = useRoute()
// Page-loading state emitted around client-side navigations; throttled by
// Nuxt so quick route changes don't flash the icon.
const { isLoading: route_loading } = useLoadingIndicator()

const breadcrumb_home = {
  icon: 'lucide:house',
  label: '首页',
  route: '/',
}
const breadcrumb_items = computed(() => {
  if (route.path === '/') {
    return []
  }
  if (route.path === '/contact') {
    return [{ label: '联系我们' }]
  }
  if (route.path === '/admin') {
    return [{ label: '控制台' }]
  }
  if (route.path === '/content') {
    return [{ label: '蠢猪档案' }]
  }
  if (route.path.startsWith('/content/')) {
    // The new-story route is `/content/new/edit`; it has no id to show yet.
    const story_id = String(route.params.id ?? '')
    const suffix = /^\d+$/.test(story_id) ? ` #${story_id}` : ''
    return [
      { label: '蠢猪档案', route: '/content' },
      { label: `${route.path.endsWith('/edit') ? '编辑' : '详情'}${suffix}` },
    ]
  }
  if (route.path.startsWith('/u/')) {
    return [{ label: `用户主页 #${route.params.id}` }]
  }

  return route.path
    .split('/')
    .filter(Boolean)
    .map(segment => ({ label: decodeURIComponent(segment) }))
})

// Document title follows the breadcrumb trail (首页 excluded); pages with
// richer data (story/user titles) override it with their own useHead.
const document_title = computed(() => {
  const parts = breadcrumb_items.value.map(item => item.label)
  return parts.length ? parts.join(' - ') : undefined
})
useHead({ title: document_title })

const site_url = useRuntimeConfig().public.site_url

useSeoMeta({
  description: '蠢猪小组（Stupig）官方网站：蠢猪档案与成员主页。',
  ogSiteName: 'Stupig 蠢猪小组',
  ogType: 'website',
  ogUrl: computed(() => `${site_url}${route.path}`),
})

useHead({
  link: computed(() => [{ rel: 'canonical', href: `${site_url}${route.path}` }]),
})

const header_shift_distance = 80
const header_shift_progress = ref(0)
const scrolled = computed(() => header_shift_progress.value > 0)
// The indicator sits in the logo's slot and its centre tracks the logo while
// the header is expanded, then settles onto the breadcrumb row's centre once
// the row has slid up to fill the header. Kept on a wrapper so the icon's spin
// animation owns its own `transform`.
const indicator_shift_style = computed(() => ({
  transform: `translateY(-${0.125 * header_shift_progress.value}rem)`,
}))
const logo_spacer_style = computed(() => {
  const progress = header_shift_progress.value
  const remaining = 1 - progress

  return {
    height: `${3.4 * remaining}rem`,
  }
})
const logo_style = computed(() => {
  const progress = header_shift_progress.value

  return {
    opacity: 1 - progress,
    transform: `translateY(-${0.6 * progress}rem)`,
  }
})
const breadcrumb_row_style = computed(() => ({
  '--header-shift-progress': header_shift_progress.value,
  // Only once the row has slid under the logo slot does the indicator share
  // that space, so the trail steps aside for it.
  '--indicator-inset': route_loading.value ? 1 : 0,
  'height': `${2.25 + 1.25 * header_shift_progress.value}rem`,
}))

// Live total height of the fixed header (logo spacer + breadcrumb row), so
// sticky content (story headings) can pin right below it. The measured px
// value tracks the header's shrink animation frame-by-frame; the rem formula
// is only the SSR / pre-measurement fallback.
const app_header = useTemplateRef<HTMLElement>('app_header')
const app_header_height = ref<number | null>(null)
const header_height_var = computed(() => ({
  '--app-header-height': app_header_height.value === null
    ? `${3.4 * (1 - header_shift_progress.value) + 2.25 + 1.25 * header_shift_progress.value}rem`
    : `${app_header_height.value}px`,
}))

function on_scroll() {
  header_shift_progress.value = Math.min(Math.max(window.scrollY / header_shift_distance, 0), 1)
}
function on_escape_key(event: KeyboardEvent) {
  if (event.key === 'Escape')
    clear_toasts()
}
let header_observer: ResizeObserver | null = null
onMounted(() => {
  // The first-paint mask is injected by the inline head script in nuxt.config.ts.
  (window as Window & { __hide_app_loading_mask?: () => void }).__hide_app_loading_mask?.()

  on_scroll()
  window.addEventListener('scroll', on_scroll, { passive: true })
  window.addEventListener('keydown', on_escape_key)
  if (app_header.value) {
    header_observer = new ResizeObserver(() => {
      app_header_height.value = app_header.value?.offsetHeight ?? null
    })
    header_observer.observe(app_header.value)
  }
})
onUnmounted(() => {
  window.removeEventListener('scroll', on_scroll)
  window.removeEventListener('keydown', on_escape_key)
  header_observer?.disconnect()
})

const lor_modal = ref(false)
const lor = ref<'login' | 'register'>('login')
const lor_login_with = ref<'password' | 'phone'>('password')

const resolver_login_pwd = zodResolver(form_schema.login_with_password)
const resolver_login_phone = zodResolver(form_schema.login_with_phone)
const resolver_register = zodResolver(form_schema.register)

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

async function sync_current_user() {
  if (! user.value) {
    return
  }

  const profile = await profile_api.get_me()

  update_user({
    id: profile.id,
    username: profile.username,
    phone: profile.phone || user.value?.phone || '',
    avatar_file: profile.avatar_file,
    avatar_version: profile.avatar_version,
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

    await auth_api.send_otp({ phone, purpose, ... captcha })

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

  const values = form_schema.login_with_password.parse(e.values)
  lor_pending.value = true

  try {
    const captcha = await captcha_verify()

    const data = await auth_api.login_with_password({
      ... values,
      ... captcha,
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

  const values = form_schema.login_with_phone.parse(e.values)
  lor_pending.value = true

  try {
    await captcha_verify()

    const data = await auth_api.login_with_phone(values)

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

  const values = form_schema.register.parse(e.values)
  lor_pending.value = true

  try {
    await captcha_verify()

    const data = await auth_api.register(values)

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

<style scoped>
.breadcrumb-row {
  overflow-x: auto;
  scrollbar-width: none;
  /* Reserve the logo slot for the loading indicator once the header is folded. */
  padding-inline-start: calc(1rem + 2.75rem * var(--header-shift-progress) * var(--indicator-inset, 0));
  transition: padding-inline-start 0.2s ease-out;
  padding-inline-end: calc(1rem + 9rem * var(--header-shift-progress));
  /* Fade overflowing items out before they slide under the right-side buttons. */
  mask-image: linear-gradient(
    to right,
    black calc(100% - (1rem + 9rem * var(--header-shift-progress))),
    transparent calc(100% + 1rem - 9rem * var(--header-shift-progress))
  );
}

.breadcrumb-row::-webkit-scrollbar {
  display: none;
}

.breadcrumb-row :deep(.p-breadcrumb) {
  flex-shrink: 0;
}

.breadcrumb-row :deep(.p-breadcrumb-list) {
  flex-wrap: nowrap;
}

.breadcrumb-row :deep(.p-breadcrumb-list li) {
  flex-shrink: 0;
  white-space: nowrap;
}

/* Opacity only: the wrapper's transform is bound to the scroll-driven shift. */
.route-loading-enter-active {
  transition: opacity 0.2s ease-out;
}

.route-loading-leave-active {
  transition: opacity 0.15s ease-in;
}

.route-loading-enter-from,
.route-loading-leave-to {
  opacity: 0;
}
</style>
