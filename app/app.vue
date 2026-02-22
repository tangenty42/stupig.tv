<template>
  <UHeader :toggle="false">
    <template #left>
      <ULink class="hover:blur-[1px] active:blur-[1px] transition-[filter] duration-300" to="/">
        <img class="h-10 w-auto dark:hidden" src="/imgs/logo_fancy.svg" alt="Stupig Logo" />
        <img class="h-10 w-auto light:hidden" src="/imgs/logo_fancy_light.svg" alt="Stupig Logo" />
      </ULink>
    </template>
    <template #right>
      <UColorModeButton />
      <UUser v-if="!! useCookie('login')" class="cursor-pointer" size="sm" name="是个人物" description="点此登录 / 注册" :avatar="{ icon: 'i-lucide-user' }" to="javascript: //植入病毒;" @click="() => void (login_modal = true)" />
    </template>
  </UHeader>
  <UMain class="overflow-x-clip">
    <NuxtPage />
  </UMain>
  <UModal id="login" v-model:open="login_modal" description="忘账号密码者，皆蠢猪耶？" :ui="{ footer: 'justify-end' }">
    <template #title>
      <img class="h-10 mb-1 w-auto dark:invert" src="/imgs/logo_regular.svg" alt="Stupig Logo" />
      <span>登录 / 注册</span>
    </template>
    
    <template #body>
      <UTabs v-model="login_or_register" :items="login_tab_items">
        <template #login>

        </template>
        <template #register>

        </template>
      </UTabs>
    </template>

    <template #footer>
      <Transition name="fade-down" mode="out-in">
        <div v-if="login_or_register === LoginOrRegister.Login" key="login" class="flex gap-1.5">
          <UButton icon="twemoji:pig-face" label="我是蠢猪，密码忘了" color="neutral" variant="outline" />
          <UButton label="立即登录" color="neutral" />
        </div>
        <div v-else key="register" class="flex gap-1.5">
          <UButton label="立即注册" color="neutral" />
        </div>
      </Transition>
    </template>
  </UModal>
</template>

<script lang="ts" setup>
  const login_modal = ref(false)
  enum LoginOrRegister {
    Login = '0',
    Register = '1'
  }
  const login_or_register = ref(LoginOrRegister.Login)
  const login_tab_items = reactive([
    {
      label: '登录',
      icon: 'lucide:user-check',
      slot: 'login'
    },
    {
      label: '注册',
      icon: 'lucide:circle-plus',
      slot: 'register'
    }
  ])

  const login_form = reactive({
    username: '',
    phone: '',
    phone_vcode: '',
    password: '',
    new_password: '',
    confirm_password: ''
  })
</script>
