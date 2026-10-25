<template>
  <div class="pb-12 pt-8">
    <template v-if="story">
      <MyContentStoryHeader back :editable="can_manage_content" :title="story.title" :labels="story.labels" :desc="story.desc" :cover="story.cover" :cover-label="story.cover_label" :cover-url="story.cover_url" :date="format_event_range(story.event_precision, story.event_dates, time_context.timezone)" :story-id="story.id" />

      <MyDivider class="mt-12">
        正文
      </MyDivider>

      <MyHeightSection tag="section" class="section-card-collapse mt-6">
        <MyContentMarkdownPreview :markdown="story.markdown" :story-id="story.id" :attachments="workspace_attachments" :folders="workspace_folders" :stories="stories ?? []" folder-openable @folder-open="open_attachment_folder" />
      </MyHeightSection>

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

      <MyDivider class="mt-12">
        附件
      </MyDivider>

      <MyHeightSection ref="attachment_section" tag="section" class="section-card-collapse mt-6">
        <MyContentAttachmentWorkspace :controller="attachment_panel" layout="stack" />
      </MyHeightSection>
    </template>

    <div v-else class="section-card-collapse py-12 text-center text-slate-500 dark:text-slate-400">
      档案不存在或已被删除
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ContentStoryBody, ContentStorySummary } from '@shared/types/content'
import { attachment_ancestor_folders } from '@shared/content-markdown'
import { has_permission } from '@shared/permissions'
import { sync_resource } from '@shared/types/sync'
import { story_front_cover_url } from '~/utils/content/attachment'
import { format_event_range } from '~/utils/content/event'
import { read_content_resource } from '~/utils/content/read-resource'

const route = useRoute()
const { content } = useApi()
const { user } = useAuth()
const time_context = useDisplayTimeContext()

const story_id = computed(() => Number(route.params.id))
const attachment_panel = await useAttachmentPanel(story_id.value, () => '', true)
const attachment_workspace = attachment_panel.catalog
const workspace_attachments = computed(() => attachment_workspace.data.value?.attachments ?? [])
const workspace_folders = computed(() => attachment_workspace.data.value?.folders ?? [])
const can_manage_content = computed(() => has_permission(user.value, 'content_manage', 'full'))

const story = useSyncedState<ContentStoryBody | null>(`content_story_view_${String(route.params.id)}`, () => null)
const loading = useState(`content_story_view_loading_${String(route.params.id)}`, () => false)

useHead({
  title: computed(() => story.value ? `蠢猪档案 - ${story.value.title}` : undefined),
})

await useSyncedData<ContentStoryBody | null>(
  computed(() => {
    const id = story_id.value
    return Number.isInteger(id) && id > 0 ? sync_resource('content_story', id) : null
  }),
  () => read_content_resource(() => content.get_story_body(story_id.value)),
  story,
  loading,
)

const stories = useSyncedState<ContentStorySummary[] | null>('content_stories', () => null)
const stories_loading = useState('content_stories_loading', () => false)

await useSyncedData<ContentStorySummary[]>(
  sync_resource('content_stories', 'all'),
  () => content.list_stories(),
  stories,
  stories_loading,
)

const attachment_section = ref<{ el: HTMLElement | null } | null>(null)
function open_attachment_folder(folder: string) {
  const paths = new Set([folder, ... attachment_ancestor_folders(folder)])
  const next = new Set(attachment_panel.expanded.value)
  for (const node of attachment_workspace.data.value?.nodes ?? []) {
    if (node.kind === 'folder' && paths.has(node.path))
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
