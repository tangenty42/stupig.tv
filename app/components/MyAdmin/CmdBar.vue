<template>
  <div class="relative">
    <div>
      <div class="flex items-center gap-3">
        <MyIcon name="lucide:terminal" class="shrink-0 text-slate-400" />
        <AutoComplete
          ref="ac_ref"
          v-model="cmd"
          :suggestions="suggestions"
          :placeholder="can_manage ? '输入筛选条件或管理命令' : '输入筛选条件，如 is_banned = TRUE'"
          :aria-label="can_manage ? '筛选条件或管理命令' : '筛选条件'"
          :complete-on-focus="true"
          :delay="100"
          class="w-full"
          input-class="!bg-transparent !border-0 !shadow-none !outline-none !font-mono !text-sm !text-slate-800 placeholder:!text-slate-400 dark:!text-slate-200 dark:placeholder:!text-slate-500"
          overlay-class="!overflow-hidden"
          fluid
          @complete="on_complete"
          @option-select="on_option_select"
        >
          <template #option="{ option }">
            <div class="flex w-full items-center gap-2">
              <span class="font-mono text-xs"><MyIcon :name="suggestion_icon(option)" class="me-2 opacity-60" />{{ option }}</span>
              <span class="ml-auto text-xs opacity-50">{{ suggestion_desc(option) }}</span>
            </div>
          </template>
        </AutoComplete>
        <div v-if="cmd" class="flex shrink-0 items-center gap-1">
          <Button
            severity="secondary"
            variant="text"
            class="!p-1 !text-slate-400"
            aria-label="清空输入框"
            @click="clear"
          >
            <MyIcon name="lucide:x" class="text-base" />
          </Button>
        </div>
        <Button
          severity="secondary"
          variant="text"
          class="shrink-0 !p-1 !text-slate-400 hover:!text-sky-600 dark:hover:!text-sky-400"
          :aria-label="can_manage ? '执行筛选或命令' : '应用筛选条件'"
          @click="execute"
        >
          <MyIcon name="lucide:corner-down-left" class="text-base" />
        </Button>
      </div>
    </div>

    <!-- Error -->
    <div v-if="invalid" class="form-error">
      {{ error_msg }}
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AdminCommand } from '@shared/admin-command'
import type AutoComplete from 'primevue/autocomplete'
import { ADMIN_COMMANDS, ADMIN_FILTER_KEYWORDS } from '@shared/admin-command'
import { ADMIN_FILTER_FIELDS } from '@shared/types/user'
import sqlParser from 'node-sql-parser'

const props = defineProps<{
  selected_ids: Set<number>
  can_manage: boolean
}>()

const emit = defineEmits<{
  (e: 'execute-filter', filter: string): void
  (e: 'execute-command', command: AdminCommand | ''): void
}>()

const sql_parser = new sqlParser.Parser()

type AutoCompleteInstance = InstanceType<typeof AutoComplete> & {
  overlayVisible: boolean
  focusedOptionIndex: number
  show: () => void
  hide: () => void
  $refs: { focusInput: any }
}

const ac_ref = ref<AutoCompleteInstance | null>(null)

onMounted(() => {
  const ref_target = ac_ref.value?.$refs?.focusInput
  const input_el: HTMLElement | null = ref_target?.$el ?? ref_target
  if (! input_el?.addEventListener) {
    return
  }

  // Capture keydown before AutoComplete's own handler so we can call execute()
  // when Enter is pressed and no suggestion is being selected.
  input_el.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === 'NumpadEnter')) {
      const is_selecting = ac_ref.value?.overlayVisible && (ac_ref.value?.focusedOptionIndex ?? - 1) >= 0
      if (! is_selecting) {
        e.stopPropagation()
        execute()
      }
    }
  }, { capture: true })
})

const cmd = ref('')
const suggestions = ref<string[]>([])
const invalid = ref(false)
const error_msg = ref('')
let cmd_before_selection = ''

// Keep cmd_before_selection in sync with every user keystroke (before AutoComplete's selection overwrites it)
watch(cmd, (newVal, oldVal) => {
  cmd_before_selection = oldVal
}, { flush: 'sync' })

const all_suggestions = computed(() => [
  ... ADMIN_FILTER_FIELDS,
  ... ADMIN_FILTER_KEYWORDS,
  ... (props.can_manage ? ADMIN_COMMANDS : []),
])

function suggestion_icon(sug: string) {
  if (ADMIN_COMMANDS.some(command => command === sug)) {
    return 'lucide:zap'
  }
  if (ADMIN_FILTER_FIELDS.some(field => field === sug)) {
    return 'lucide:columns-3'
  }
  return 'lucide:code'
}

function suggestion_desc(sug: string) {
  if (ADMIN_COMMANDS.some(command => command === sug)) {
    return '命令'
  }
  if (ADMIN_FILTER_FIELDS.some(field => field === sug)) {
    return '字段'
  }
  return '关键字'
}

function last_token(text: string) {
  if (text.endsWith(' ')) {
    return ''
  }
  const last_space = text.lastIndexOf(' ')
  return last_space >= 0 ? text.slice(last_space + 1) : text
}

function on_complete(e: any) {
  const query = (e.query ?? '') as string
  const token = last_token(query)

  if (! token) {
    suggestions.value = all_suggestions.value
  }
  else {
    const lower = token.toLowerCase()
    suggestions.value = all_suggestions.value.filter(
      s => s.toLowerCase().startsWith(lower) && s.toLowerCase() !== lower,
    )
  }

  // AutoComplete's internal suggestions watcher relies on the `searching`
  // flag which may not be in sync on re-focus/re-click.
  ac_ref.value?.show?.()
}

function on_option_select(e: any) {
  // AutoComplete already set cmd = the selected value.
  // Restore the original cmd and insert the token at the cursor position.
  const selected = e.value as string
  cmd.value = cmd_before_selection
  apply_suggestion_inner(selected)
  // Close overlay — AutoComplete auto-hides on selection,
  // but ensure it's hidden to prevent flicker from our cmd update
  nextTick(() => ac_ref.value?.hide?.())
}

function apply_suggestion_inner(sug: string) {
  suggestions.value = []
  const raw = cmd.value
  const trimmed = raw.trimEnd()
  const last_space = trimmed.lastIndexOf(' ')
  const is_command = ADMIN_COMMANDS.some(command => command === sug)
  const space = is_command ? '' : ' '

  if (last_space < 0) {
    // No space → entire content is the token being replaced
    cmd.value = sug + space
  }
  else {
    const prefix = raw.slice(0, last_space + 1)
    cmd.value = prefix + sug + space
  }
}

function clear() {
  cmd.value = ''
  suggestions.value = []
  invalid.value = false
  error_msg.value = ''
  ac_ref.value?.hide?.()
  nextTick(() => {
    const input_el = ac_ref.value?.$refs?.focusInput
    if (input_el)
      input_el.focus()
  })
}

function execute() {
  const val = cmd.value.trim()
  if (! val) {
    invalid.value = false
    error_msg.value = ''
    ac_ref.value?.hide?.()
    emit('execute-command', '')
    return
  }

  const upper = val.toUpperCase()
  const known_command = ADMIN_COMMANDS.find(command => command === upper)
  if (known_command) {
    if (! props.can_manage) {
      invalid.value = true
      error_msg.value = '只有管理员能使用管理命令。你可以输入筛选条件查找用户。'
      return
    }
    if (known_command !== 'ALL' && props.selected_ids.size === 0) {
      invalid.value = true
      error_msg.value = '请先点选要操作的用户卡片'
      return
    }
    invalid.value = false
    error_msg.value = ''
    emit('execute-command', known_command)
    cmd.value = ''
    ac_ref.value?.hide?.()
    return
  }

  try {
    sql_parser.astify(`SELECT * FROM users WHERE ${val}`)
  }
  catch {
    invalid.value = true
    error_msg.value = '筛选条件语法有误，可写成 id = 1'
    return
  }

  if (/;|--|\/\*/.test(val)) {
    invalid.value = true
    error_msg.value = '筛选条件中不能使用分号或注释'
    return
  }

  invalid.value = false
  error_msg.value = ''
  cmd.value = ''
  ac_ref.value?.hide?.()
  emit('execute-filter', val)
}
</script>
