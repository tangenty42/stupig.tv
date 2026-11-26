<template>
  <div class="space-y-12 pb-12 pt-8">
    <template v-if="profile">
      <MyAccountProfileOverview
        :profile="profile"
        :is-operating-other="is_operating_other"
        @edit-phone="security_section?.scroll_to_phone_form()"
      />

      <MyAccountProfileSecurity
        v-if="profile.editable"
        ref="security_section"
        :profile="profile"
        :is-operating-other="is_operating_other"
      />
      <MyAccountProfileSessions
        v-if="profile.sensitive_readable"
        :profile="profile"
        :is-viewing-other="is_viewing_other"
      />
    </template>
    <div v-else-if="loading && ! missing" class="flex justify-center py-12 text-slate-500 dark:text-slate-400" role="status" aria-label="正在加载用户资料">
      <MyIcon name="lucide:loader-circle" size="3rem" class="animate-spin" />
    </div>
    <MyContentListLoadError v-else-if="failed" class="py-12" @retry="retry_profile" />
    <div v-else-if="missing" class="space-y-4 py-12 text-center text-slate-500 dark:text-slate-400">
      <p>用户不存在</p>
      <NuxtLink class="link" to="/">
        返回首页
      </NuxtLink>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useAccountProfile } from '~/features/account/profile'
import { avatar_url } from '~/utils/avatar'

const route = useRoute()
const static_url = useStaticUrl()
const profile_key = computed(() => String(route.params.id ?? ''))
const account_profile = useAccountProfile(profile_key)
const { profile, loading, failed, missing, is_operating_other, is_viewing_other } = account_profile
const security_section = useTemplateRef<{ scroll_to_phone_form: () => void }>('security_section')

useHead({
  title: computed(() => profile.value ? `用户主页 - ${profile.value.username}` : undefined),
})

useSeoMeta({
  description: computed(() => profile.value ? `蠢猪小组成员『${profile.value.username}』的主页` : undefined),
  ogTitle: computed(() => profile.value ? `用户主页 - ${profile.value.username}` : undefined),
  ogDescription: computed(() => profile.value ? `蠢猪小组成员『${profile.value.username}』的主页` : undefined),
  ogType: 'profile',
  ogImage: computed(() => (profile.value ? avatar_url(static_url, profile.value.avatar_file, profile.value.avatar_version) : null) ?? undefined),
})

const { refresh: retry_profile } = await account_profile.ready
</script>
