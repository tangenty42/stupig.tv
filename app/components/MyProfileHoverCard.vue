<template>
  <div ref="root_ref" class="relative" @mouseenter="on_enter" @mouseleave="on_leave">
    <div
      role="button"
      tabindex="0"
      :aria-expanded="open"
      aria-haspopup="true"
      aria-controls="user-hover-menu"
      :aria-label="`用户菜单：${profile.username}`"
      class="flex cursor-pointer items-center gap-2 rounded-full px-2 py-1 transition sm:hover:bg-[var(--p-content-hover-background)]"
    >
      <MyAvatar :user="profile" size="small" />
      <div class="hidden sm:flex items-center gap-1 pe-1">
        <span class="text-sm font-medium">{{ profile.username }}</span>
        <MyIcon v-if="profile.is_verified" name="lucide:badge-check" class="text-emerald-500" />
      </div>
    </div>

    <Transition name="fade-down">
      <MyHeightSection
        v-show="open"
        id="user-hover-menu"
        tag="div"
        role="region"
        aria-label="用户菜单"
        class="section-card pt-5 pb-3 !shadow-lg absolute right-0 top-[calc(100%+0.4rem)] z-20 w-72"
        @click.stop
      >
        <div class="mb-4 flex items-center gap-3.5">
          <MyAvatar :user="profile" size="medium" previewable />
          <div class="w-full flex flex-col gap-1">
            <span class="font-medium inline-flex items-center gap-1">
              <span>{{ profile.username }}</span>
              <MyIcon v-if="profile.is_verified" name="lucide:badge-check" class="text-emerald-500" />
            </span>
            <span class="text-xs text-slate-500">UID #{{ profile.id }}</span>
          </div>
        </div>

        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            <NuxtLink class="text-sm link" :to="profile_link">
              <MyIcon name="lucide:user" />
              我的主页
            </NuxtLink>
            <NuxtLink v-if="profile.is_admin" class="text-sm link" to="/admin">
              <MyIcon name="lucide:settings" />
              控制台
            </NuxtLink>
          </div>
          <Button aria-label="退出登录" text rounded severity="secondary" @click="$emit('logout')">
            <template #icon>
              <MyIcon name="lucide:log-out" />
            </template>
          </Button>
        </div>
      </MyHeightSection>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import type { LoginUser } from '@/composables/useAuth'

const props = defineProps<{
  profile: LoginUser
}>()

defineEmits<{
  logout: []
}>()

const open = ref(false)
const root_ref = ref<HTMLElement | null>(null)
let hide_timer: ReturnType<typeof setTimeout> | null = null

const profile_link = computed(() => `/u/${props.profile.id}`)

function on_enter() {
  if (hide_timer) {
    clearTimeout(hide_timer)
    hide_timer = null
  }
  open.value = true
}

function on_leave() {
  hide_timer = setTimeout(() => {
    open.value = false
    hide_timer = null
  }, 150)
}

function on_outside_click(event: MouseEvent | TouchEvent) {
  if (! open.value) {
    return
  }
  if (root_ref.value && ! root_ref.value.contains(event.target as Node)) {
    open.value = false
  }
}

onMounted(() => {
  document.addEventListener('mousedown', on_outside_click)
  document.addEventListener('touchstart', on_outside_click)
})

onUnmounted(() => {
  if (hide_timer) {
    clearTimeout(hide_timer)
  }
  document.removeEventListener('mousedown', on_outside_click)
  document.removeEventListener('touchstart', on_outside_click)
})
</script>

<style scoped>
  .fade-down-enter-active {
    transition: all 0.2s ease-out;
  }
  .fade-down-leave-active {
    transition: all 0.1s ease-in;
  }
  .fade-down-enter-from {
    opacity: 0;
    transform: translateY(4px);
  }
  .fade-down-leave-to {
    opacity: 0;
    transform: translateY(4px);
  }
</style>
