<template>
  <div class="space-y-12 pb-12 pt-8">
    <template v-if="profile">
      <MyAccountProfileOverview
        :profile="profile"
        :is-operating-other="is_operating_other"
        @edit-phone="security_section?.scroll_to_phone_form()"
      />

      <template v-if="profile.editable">
        <MyAccountProfileSecurity
          ref="security_section"
          :profile="profile"
          :is-operating-other="is_operating_other"
        />
        <MyAccountProfileSessions
          :profile="profile"
          :is-operating-other="is_operating_other"
        />
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useAccountProfile } from '~/features/account/profile'
import { avatar_url } from '~/utils/avatar'

const route = useRoute()
const static_url = useStaticUrl()
const profile_key = computed(() => String(route.params.id ?? ''))
const account_profile = useAccountProfile(profile_key)
const { profile, is_operating_other } = account_profile
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

await account_profile.ready
</script>
