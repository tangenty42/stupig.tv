<template>
  <div class="pb-12 pt-8">
    <MyHeightSection tag="section" class="section-card-collapse">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <h1 class="flex flex-wrap items-baseline gap-x-4">
          <span v-if="shown_view === 'published' && stories" class="font-normal text-[60%]">{{ stories.length }} 份の</span>
          <span>蠢猪档案！</span>
        </h1>
        <div v-if="can_manage_content" class="flex flex-wrap items-center gap-3">
          <SelectButton v-model="selected_view" :options="view_options" option-label="label" option-value="value" :allow-empty="false" aria-label="档案类型" size="small">
            <template #option="{ option }">
              <span class="whitespace-nowrap">
                <MyIcon :name="option.icon" class="mr-1.5" />
                <span>{{ option.label }}</span>
              </span>
            </template>
          </SelectButton>
          <Button size="small" label="新建" @click="navigateTo('/content/new/edit')">
            <template #icon>
              <MyIcon name="lucide:plus" />
            </template>
          </Button>
        </div>
      </div>
    </MyHeightSection>

    <MyHeightSection tag="section" class="section-card-collapse mt-12 transition-opacity duration-200" :class="{ 'opacity-60 delay-150': switching }" :aria-busy="switching">
      <!-- The draft list awaits its initial request; this boundary keeps the current list on screen until it
           resolves, so switching never flashes a skeleton or an empty section. -->
      <Suspense suspensible @pending="switching = true" @resolve="show_selected_view">
        <MyContentStoryPublishedList
          v-if="selected_view === 'published'"
          v-model:sort-by-rating="sort_by_rating"
          :stories="stories"
          :loading="loading"
          :active-labels="active_labels"
          @retry="retry_stories"
          @toggle-label="toggle_label"
          @clear-labels="active_labels.clear()"
        />
        <MyContentStoryDraftList v-else />
      </Suspense>
    </MyHeightSection>

    <MyDivider v-if="shown_view === 'published' && stories" class="mt-24">
      事件日历
    </MyDivider>

    <MyHeightSection v-if="shown_view === 'published' && stories" tag="section" class="section-card-collapse mt-6">
      <MyContentStoryCalendar :stories="stories" />
    </MyHeightSection>
  </div>
</template>

<script setup lang="ts">
import { has_permission } from '@shared/permissions'
import { useContentStories } from '~/features/content/stories'

const { user } = useAuth()
const route = useRoute()
const router = useRouter()

const can_manage_content = computed(() => has_permission(user.value, 'content_access', 'full'))
const view_options = [{ label: '已发布', value: 'published', icon: 'lucide:book-open' }, { label: '未发布草稿', value: 'drafts', icon: 'lucide:pencil' }]
const selected_view = computed({
  get: () => can_manage_content.value && route.query.view === 'drafts' ? 'drafts' : 'published',
  set: (value: string) => { void router.replace({ query: { ... route.query, view: value === 'drafts' ? 'drafts' : undefined } }) },
})

// The count, divider and calendar follow the list actually on screen, not the pending choice.
const shown_view = ref(selected_view.value)
const switching = ref(false)
function show_selected_view() {
  switching.value = false
  shown_view.value = selected_view.value
}

const active_labels = reactive(new Set<string>())
const sort_by_rating = ref(false)

function toggle_label(label: string) {
  if (! active_labels.delete(label))
    active_labels.add(label)
}

const { stories, loading, ready } = useContentStories()
const { refresh: retry_stories } = await ready
</script>
