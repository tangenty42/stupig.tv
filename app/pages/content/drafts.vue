<script setup lang="ts">
definePageMeta({
  middleware: () => navigateTo({ path: '/content', query: { view: 'drafts' } }, { redirectCode: 302, replace: true }),
})
</script>
