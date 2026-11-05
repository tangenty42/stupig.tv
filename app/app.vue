<template>
  <div class="min-h-screen overflow-x-clip" :style="app_layout_vars">
    <Toast position="center" />
    <ConfirmPopup :pt="{ transition: confirm_popup_transition }">
      <template #accepticon>
        <MyIcon name="lucide:check" />
      </template>
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
            <MyIcon name="lucide:loader-circle" size="2.5rem" class="animate-spin text-slate-400" />
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
          <Button v-else label="登录 / 注册" size="small" severity="secondary" text @click="auth_dialog_visible = true">
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

    <MyAccountAuthDialog v-model:visible="auth_dialog_visible" />
  </div>
</template>

<script lang="ts" setup>
import { confirm_popup_transition } from '~/composables/useMyConfirm'
import { useAccountIdentity } from '~/features/account/auth'

const static_url = useStaticUrl()
const { clear: clear_toasts } = useMyToast()
const account = useAccountIdentity()
const { user, logout } = account
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

const public_config = useRuntimeConfig().public
const site_url = public_config.site.url

useSeoMeta({
  description: '我们是来自广州市西关外国语学校的 Stupig 蠢猪小组！！！',
  ogSiteName: 'Stupig 蠢猪小组',
  ogType: 'website',
  ogUrl: computed(() => `${site_url}${route.path}`),
})

useHead({
  link: computed(() => [
    { rel: 'canonical', href: `${site_url}${route.path}` },
    { rel: 'icon', href: static_url('/imgs/Stupig_icon.svg') },
  ]),
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
const app_half_viewport_width = ref('50vw')
const app_layout_vars = computed(() => ({
  '--app-half-viewport': app_half_viewport_width.value,
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
let viewport_observer: ResizeObserver | null = null
onMounted(() => {
  if (! CSS.supports('overflow', 'clip')) {
    // Full-bleed bands must exclude scrollbar gutters when the app root
    // cannot clip them. Keep sticky content on the document's scroll root.
    const measure_viewport = () => app_half_viewport_width.value = `${document.documentElement.clientWidth / 2}px`
    measure_viewport()
    viewport_observer = new ResizeObserver(measure_viewport)
    viewport_observer.observe(document.documentElement)
  }
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
  viewport_observer?.disconnect()
})

const auth_dialog_visible = ref(false)

function toggle_color_mode() {
  color_mode.preference = color_mode.value === 'dark' ? 'light' : 'dark'
}

await account.ready
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
