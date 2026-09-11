<template>
  <div class="pb-12 pt-8">
    <template v-if="story">
      <MyContentStoryHeader back :editable="is_admin" :title="story.title" :labels="story.labels" :desc="story.desc" :cover="story.cover" :cover-label="story.cover_label" :cover-url="story.cover_url" :date="format_event_range(story.event_precision, story.event_dates)" :story-id="story.id" />

      <MyDivider class="mt-12">
        正文
      </MyDivider>

      <MyHeightSection tag="section" class="section-card-collapse mt-6">
        <MyContentMarkdownPreview :markdown="story.markdown" :story-id="story.id" :attachments="story.attachments" :stories="stories ?? []" folder-openable @folder-open="open_attachment_folder" />
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
        <MyContentAttachmentList
          :rows="attachment_rows"
          :upload_busy="false"
          readonly
          layout="stack"
          @row-click="on_attachment_row_click"
        />
      </MyHeightSection>
    </template>

    <div v-else class="section-card-collapse py-12 text-center text-slate-500 dark:text-slate-400">
      档案不存在或已被删除
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ContentStoryAttachment, ContentStoryDetail, ContentStorySummary } from '@shared/types/content'
import type { MyContentAttachmentRow } from '~/utils/content/attachment'
import { attachment_ancestor_folders, attachment_base_name, attachment_folder_of, compare_attachment_names } from '@shared/content-markdown'
import { sync_resource } from '@shared/types/sync'
import { story_front_cover_url } from '~/utils/content/attachment'
import { format_event_range } from '~/utils/content/event'

const route = useRoute()
const { content } = useApi()
const { user } = useAuth()

const story_id = computed(() => Number(route.params.id))
const is_admin = computed(() => Boolean(user.value?.is_admin))

const story = useState<ContentStoryDetail | null>(`content_story_view_${String(route.params.id)}`, () => null)
const loading = useState(`content_story_view_loading_${String(route.params.id)}`, () => false)

useHead({
  title: computed(() => story.value ? `蠢猪档案 - ${story.value.title}` : undefined),
})

await useSyncedData<ContentStoryDetail>(
  computed(() => {
    const id = story_id.value
    return Number.isInteger(id) && id > 0 ? sync_resource('content_story', id) : null
  }),
  async () => {
    const current = story.value
    if (! current) {
      return content.get_story(story_id.value)
    }
    return await content.get_story(story_id.value, current.updated_at) ?? current
  },
  story,
  loading,
)

const stories = useState<ContentStorySummary[] | null>('content_stories', () => null)
const stories_loading = useState('content_stories_loading', () => false)

await useSyncedData<ContentStorySummary[]>(
  computed(() => sync_resource('content_stories', 'all')),
  () => content.list_stories(),
  stories,
  stories_loading,
)

// Folders start collapsed; the set tracks only the ones the user expanded.
const expanded_attachment_folders = ref(new Set<string>())

const attachment_folder_names = computed(() => {
  const names = new Set(story.value?.folders ?? [])
  for (const attachment of story.value?.attachments ?? []) {
    let folder = attachment_folder_of(attachment.file_name)
    while (folder) {
      names.add(folder)
      folder = attachment_folder_of(folder)
    }
  }
  return [... names].sort(compare_attachment_names)
})

const attachment_groups = computed(() => {
  const groups = new Map<string | null, ContentStoryAttachment[]>()
  for (const attachment of story.value?.attachments ?? []) {
    const folder = attachment_folder_of(attachment.file_name)
    const parent = folder && attachment_folder_names.value.includes(folder) ? folder : null
    const group = groups.get(parent)
    if (group)
      group.push(attachment)
    else
      groups.set(parent, [attachment])
  }
  return groups
})

function attachment_folder_count(folder: string) {
  return (story.value?.attachments ?? []).filter(attachment => attachment.file_name.startsWith(`${folder}/`)).length
}

function toggle_attachment_folder(folder: string) {
  const next = new Set(expanded_attachment_folders.value)
  if (next.has(folder))
    next.delete(folder)
  else
    next.add(folder)
  expanded_attachment_folders.value = next
}

const attachment_section = ref<{ el: HTMLElement | null } | null>(null)

/**
 * Open a folder card's target: reveal it in the attachment list (its ancestors
 * too, or it would still be hidden inside a collapsed parent) and bring the list
 * into view. `scroll_to` accounts for the fixed app header.
 */
function open_attachment_folder(folder: string) {
  const next = new Set(expanded_attachment_folders.value)
  for (const path of [folder, ... attachment_ancestor_folders(folder)]) {
    next.add(path)
  }
  expanded_attachment_folders.value = next
  nextTick(() => scroll_to(attachment_section.value?.el))
}

const attachment_rows = computed<MyContentAttachmentRow[]>(() => {
  const rows: MyContentAttachmentRow[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const folder of attachment_folder_names.value.filter(name => attachment_folder_of(name) === parent)) {
      rows.push({
        key: `folder:${folder}`,
        depth,
        data: {
          kind: 'folder',
          path: folder,
          name: attachment_base_name(folder),
          collapsed: ! expanded_attachment_folders.value.has(folder),
          count: attachment_folder_count(folder),
          drop_target: false,
          drop_disabled: false,
          moving: false,
          dimmed: false,
          batch_pending: false,
        },
        state: {
          selected: false,
          selection_edges: null,
          selection_count: 0,
          delete_pending: false,
          delete_disabled: false,
          rename_disabled: true,
          replace_disabled: true,
          retry_disabled: true,
          move_pending: false,
          structure_locked: false,
        },
        item: null,
      })
      if (expanded_attachment_folders.value.has(folder))
        walk(folder, depth + 1)
    }
    for (const attachment of attachment_groups.value.get(parent) ?? []) {
      rows.push({
        key: `stored:${attachment.file_name}`,
        depth,
        data: { ... attachment, kind: 'stored', referenced: true },
        state: {
          selected: false,
          selection_edges: null,
          selection_count: 0,
          delete_pending: false,
          delete_disabled: true,
          rename_disabled: true,
          replace_disabled: true,
          retry_disabled: true,
          move_pending: false,
          structure_locked: false,
        },
        item: {
          key: `stored:${attachment.file_name}`,
          kind: 'stored',
          attachment,
          card: { ... attachment, kind: 'stored', referenced: true },
        },
      })
    }
  }
  walk(null, 0)
  return rows
})

function on_attachment_row_click(_event: MouseEvent, row: MyContentAttachmentRow) {
  if (row.data.kind === 'folder')
    toggle_attachment_folder(row.data.path)
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
