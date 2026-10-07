<template>
  <MyBadge outlined type="info" :title="resolved.description || undefined">
    <span><MyIcon name="lucide:key-round" class="me-1" />{{ resolved.name }}·{{ resolved.level_name }}</span>
  </MyBadge>
</template>

<script setup lang="ts">
import type { PermissionGrant } from '@shared/permissions'
import { resolve_permission_grant } from '@shared/permissions'

const props = defineProps<{
  grant: PermissionGrant
}>()

const resolved = computed(() => resolve_permission_grant(props.grant))
</script>
