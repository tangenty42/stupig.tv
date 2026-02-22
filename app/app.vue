<template>
  <UApp :toaster="{ position: 'top-center' }">
    <UHeader :toggle="false">
      <template #left>
        <ULink class="hover:blur-[1px] active:blur-[1px] transition-[filter] duration-300" to="/">
          <img class="h-10 w-auto dark:hidden" src="/imgs/logo_fancy.svg" alt="Stupig Logo" />
          <img class="h-10 w-auto light:hidden" src="/imgs/logo_fancy_light.svg" alt="Stupig Logo" />
        </ULink>
      </template>
      <template #right>
        <UColorModeButton />
        <UUser v-if="!! useCookie('login')" class="cursor-pointer" size="sm" name="是个人物" description="点此登录 / 注册" :avatar="{ icon: 'i-lucide-user' }" to="javascript: //植入病毒;" @click="lor_modal = true" />
      </template>
    </UHeader>
    <UMain class="overflow-x-clip">
      <NuxtPage />
    </UMain>
    <UModal v-model:open="lor_modal" description="忘账号密码者，皆蠢猪耶？" :ui="{ footer: 'justify-end' }">
      <template #title>
        <img class="h-10 mb-1 w-auto dark:invert" src="/imgs/logo_regular.svg" alt="Stupig Logo" />
        <span>登录 / 注册</span>
      </template>
      <template #body>
        <UTabs v-model="lor" :items="lor_tab_items">
          <template #login>
            <div class="flex justify-center">
              <UTabs class="w-full *:justify-center" v-model="lor_login_with" variant="link" size="sm" :items="lor_login_with_tab_items">
                <template #with-password>
                  <UForm ref="lor_form_1_ref" class="form" :schema="schema.login_with_password" :state="lor_form.login_with_password" @submit="lor_submit_login">
                    <UFormField label="用户名 / 手机号" name="username_or_phone">
                      <UInput class="w-full" v-model="lor_form.login_with_password.username_or_phone" />
                    </UFormField>
                    <UFormField label="密码" name="password">
                      <MyPwdInput class="w-full" v-model="lor_form.login_with_password.password" />
                    </UFormField>
                  </UForm>
                </template>
                <template #with-phone>
                  <UForm ref="lor_form_2_ref" class="form" :schema="schema.login_with_phone" :state="lor_form.login_with_phone" @submit="lor_submit_login">
                    <UFormField label="手机号" name="phone">
                      <UInput class="w-full" v-model="lor_form.login_with_phone.phone" type="text" inputmode="numeric" />
                    </UFormField>
                    <UFormField label="手机验证码" name="otp">
                      <template #hint>
                        <MyOtpButton v-model="lor_otp_time_login" @click="lor_send_otp" />
                      </template>
                      <Transition name="fade-down" mode="out-in">
                        <MyOtpInput v-if="lor_otp_time_login >= 0" class="w-full" v-model="lor_form.login_with_phone.otp" variant="subtle" />
                      </Transition>
                    </UFormField>
                  </UForm>
                </template>
              </UTabs>
            </div>
          </template>
          <template #register>
            <UForm ref="lor_form_3_ref" class="form" :schema="schema.register" :state="lor_form.register" @submit="lor_submit_register">
              <UFormField label="用户名" name="username">
                <UInput class="w-full" v-model="lor_form.register.username" />
              </UFormField>
              <UFormField label="手机号" name="phone">
                <UInput class="w-full" v-model="lor_form.register.phone" type="text" inputmode="numeric" />
              </UFormField>
              <UFormField label="手机验证码" name="otp">
                <template #hint>
                  <MyOtpButton v-model="lor_otp_time_register" @click="lor_send_otp" />
                </template>
                <Transition name="fade-down" mode="out-in">
                  <MyOtpInput v-if="lor_otp_time_register >= 0" class="w-full" v-model="lor_form.register.otp" variant="subtle" />
                </Transition>
              </UFormField>
              <UFormField label="密码" name="password">
                <MyPwdInput class="w-full" v-model="lor_form.register.password" />
              </UFormField>
              <UFormField label="确认密码" name="confirm_password">
                <MyPwdInput class="w-full" @paste.prevent v-model="lor_form.register.confirm_password" />
              </UFormField>
            </UForm>
          </template>
        </UTabs>
      </template>

      <template #footer>
        <Transition name="fade-down" mode="out-in">
          <div v-if="lor === LoginOrRegister.Login" key="login" class="flex gap-1.5">
            <UButton icon="lucide:check" label="立即登录" @click="lor_login_with === LoginWith.Password ? lor_form_1_ref?.submit() : lor_form_2_ref?.submit()" />
          </div>
          <div v-else key="register" class="flex gap-1.5">
            <UButton icon="lucide:check" label="立即注册" @click="lor_form_3_ref?.submit()" />
          </div>
        </Transition>
      </template>
    </UModal>
  </UApp>
</template>

<style scoped>
  @reference '@/assets/css/global.css';

  .form {
    @apply sm:px-16 py-4 space-y-4 w-full grid grid-cols-1 justify-center;
  }
</style>

<script lang="ts" setup>
  import { form_default, schema } from '../../api.stupig.tv/src/shared/validate.js'

  const toast = useToast()

  const lor_modal = ref(false)
  enum LoginOrRegister {
    Login = '0',
    Register = '1'
  }
  const lor = ref(LoginOrRegister.Login)
  const lor_tab_items = reactive([
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
  enum LoginWith {
    Password = '0',
    Phone = '1'
  }
  const lor_login_with = ref(LoginWith.Password)
  const lor_login_with_tab_items = reactive([
    {
      label: '密码登录',
      icon: 'lucide:square-asterisk',
      slot: 'with-password'
    },
    {
      label: '手机验证码登录',
      icon: 'lucide:message-square-more',
      slot: 'with-phone'
    }
  ])

  const lor_form_1_ref = useTemplateRef('lor_form_1_ref'),
    lor_form_2_ref = useTemplateRef('lor_form_2_ref'),
    lor_form_3_ref = useTemplateRef('lor_form_3_ref')
  const lor_form = reactive(form_default)

  const lor_otp_time_login = ref(- 1),
    lor_otp_time_register = ref(- 1)
  async function lor_send_otp() {
    let form_ref: typeof lor_form_2_ref.value | typeof lor_form_3_ref.value
    let time: Ref<number>

    /** Simplest & most elegant solution to those type-related problems.
     *                     I LOVE TYPESCRIPT :)
     */
    if (lor.value === LoginOrRegister.Login) {
      time = lor_otp_time_login
      await (form_ref = lor_form_2_ref!.value!).validate({ name: 'phone', silent: true })
    }
    else {
      time = lor_otp_time_register
      await (form_ref = lor_form_3_ref!.value!).validate({ name: 'phone', silent: true })
    }
    if (form_ref.getErrors('phone').length) {
      form_ref.clear(/^(?!phone).*/)
      return
    }

    time.value = 10000
    toast.add({ title: '验证码发送成功！', icon: 'lucide:message-square-more' })
  }
  function lor_submit_login() {
    console.log(lor_form.login_with_phone.otp)
    toast.add({ title: '登录成功！', icon: 'lucide:user-check' })
  }
  function lor_submit_register() {

  }
</script>
