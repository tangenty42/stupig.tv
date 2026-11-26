<template>
  <div class="pb-12 pt-8">
    <template v-if="story">
      <MyContentStoryHeader back :editable="can_manage_content" :title="story.title" :labels="story.labels" :desc="story.desc" :cover="story.cover" :cover-label="story.cover_label" :cover-url="story.cover_url" :cover-image="story.cover_image" :date="format_event_range(story.event_precision, story.event_dates, time_context.timezone)" :story-id="story.id" />

      <MyDivider class="mt-12">
        正文
      </MyDivider>

      <MyHeightSection tag="section" class="section-card-collapse mt-6">
        <MyContentMarkdownPreview :markdown="story.markdown" :story-id="story.id" :attachments="workspace_attachments" :folders="workspace_folders" :stories="stories ?? []" :can-read-private="story.private_readable && can_read_private" folder-openable @folder-open="open_attachment_folder" />
      </MyHeightSection>

      <template v-if="story.event_dates.length">
        <MyDivider class="mt-12">
          事件日历
        </MyDivider>

        <MyHeightSection tag="section" class="section-card-collapse mt-6">
          <MyContentStoryCalendar
            :stories="stories ?? []"
            :highlight_id="story.id"
            :initial_month="story.event_dates[0]?.slice(0, 7) ?? null"
          />
        </MyHeightSection>
      </template>

      <MyDivider class="mt-12">
        附件
      </MyDivider>

      <MyHeightSection ref="attachment_section" tag="section" class="section-card-collapse mt-6">
        <MyContentAttachmentWorkspace :controller="attachment_panel" layout="stack" />
      </MyHeightSection>
    </template>

    <div v-else-if="story_loading" class="section-card-collapse flex justify-center py-12 text-slate-500 dark:text-slate-400" role="status" aria-label="正在加载档案">
      <MyIcon name="lucide:loader-circle" size="3rem" class="animate-spin" />
    </div>
    <MyContentListLoadError v-else-if="story_error" class="section-card-collapse py-12" @retry="retry_story" />
    <div v-else class="section-card-collapse py-12 text-center text-slate-500 dark:text-slate-400">
      档案不存在或已被删除
    </div>
  </div>
</template>

<script setup lang="ts">
import { attachment_ancestor_folders } from '@shared/content-markdown'
import { content_name_key } from '@shared/content-reference'
import { has_permission } from '@shared/permissions'
import { useAttachmentPanel } from '~/features/content/attachments/panel'
import { content_browser_navigation } from '~/features/content/browser-navigation'
import { format_event_range } from '~/features/content/event'
import { useContentStories, useContentStory } from '~/features/content/stories'
import { story_front_cover_url } from '~/features/content/story-cover'

const route = useRoute()
const { user } = useAuth()
const time_context = useDisplayTimeContext()

const route_story_id = computed(() => String(route.params.id))
const story_id = computed(() => Number(route_story_id.value))
const story_detail = useContentStory(route_story_id)
const { story, loading: story_loading, error: story_error } = story_detail
const attachment_panel = useAttachmentPanel({
  scope: story_id.value,
  markdown: () => '',
  reference_source: () => {
    const current = story.value
    if (! current || (current.has_private && (! current.private_readable || ! has_permission(user.value, 'content_access', 'private_read'))))
      return null
    return { markdown: current.markdown, cover: current.cover }
  },
  readonly: true,
  interaction: content_browser_navigation,
})
const [{ refresh: retry_story }] = await Promise.all([story_detail.ready, attachment_panel.ready])
const attachment_workspace = attachment_panel.catalog
const workspace_attachments = computed(() => attachment_workspace.data.value?.attachments ?? [])
const workspace_folders = computed(() => attachment_workspace.data.value?.folders ?? [])
const can_read_private = computed(() => has_permission(user.value, 'content_access', 'private_read'))
const can_manage_content = computed(() => has_permission(user.value, 'content_access', 'full'))

useHead({
  title: computed(() => story.value ? `蠢猪档案 - ${story.value.title}` : undefined),
})

const story_query = useContentStories()
await story_query.ready
const { stories } = story_query

const attachment_section = ref<{ el: HTMLElement | null } | null>(null)
function open_attachment_folder(folder: string) {
  const paths = new Set([folder, ... attachment_ancestor_folders(folder)].map(content_name_key))
  const next = new Set(attachment_panel.expanded.value)
  for (const node of attachment_workspace.data.value?.nodes ?? []) {
    if (node.kind === 'folder' && paths.has(content_name_key(node.path)))
      next.add(node.id)
  }
  attachment_panel.expanded.value = next
  nextTick(() => scroll_to(attachment_section.value?.el))
}
// Seo getters are evaluated during head rendering (no Nuxt instance), so the
// composable is captured here and passed in rather than called inside the util.
const static_url = useStaticUrl()
const og_image = computed(() => {
  const current = story.value
  if (! current?.cover || current.cover.startsWith('#')) {
    return undefined
  }
  return story_front_cover_url(static_url, current.cover, current.cover_url)
})

useSeoMeta({
  description: computed(() => story.value?.desc ?? undefined),
  ogTitle: computed(() => story.value ? `蠢猪档案 - ${story.value.title}` : undefined),
  ogDescription: computed(() => story.value?.desc ?? undefined),
  ogType: 'article',
  ogImage: og_image,
  articlePublishedTime: computed(() => story.value?.created_at),
  articleModifiedTime: computed(() => story.value?.updated_at),
})
</script>
