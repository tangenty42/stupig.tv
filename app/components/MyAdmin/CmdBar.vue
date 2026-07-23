<template>
  <div class="relative">
    <div>
      <div class="flex items-center gap-3">
        <MyIcon name="lucide:terminal" class="shrink-0 text-slate-400" />
        <AutoComplete
          ref="ac_ref"
          v-model="cmd"
          :suggestions="suggestions"
          :placeholder="placeholder"
          :complete-on-focus="true"
          :delay="100"
          class="w-full"
          input-class="!bg-transparent !border-0 !shadow-none !outline-none font-mono text-sm text-slate-800 placeholder:text-slate-400 dark:text-slate-200 dark:placeholder:text-slate-500"
          overlay-class="overflow-hidden"
          fluid
          @complete="on_complete"
          @option-select="on_option_select"
        >
          <template #option="{ option }">
            <div class="flex w-full items-center gap-2">
              <MyIcon :name="suggestion_icon(option)" class="shrink-0 text-base opacity-60" />
              <span class="font-mono text-xs">{{ option }}</span>
              <span class="ml-auto text-xs opacity-50">{{ suggestion_desc(option) }}</span>
            </div>
          </template>
        </AutoComplete>
        <div v-if="cmd" class="flex shrink-0 items-center gap-1">
          <Button
            v-if="selected_ids.size > 0"
            severity="secondary"
            variant="text"
            size="small"
            :label="`${selected_ids.size} 已选`"
            class="!px-2 !py-1 !text-xs !font-medium"
            @click="emit('clear-selection')"
          />
          <Button
            severity="secondary"
            variant="text"
            rounded
            class="!p-1 !text-slate-400"
            aria-label="清空"
            @click="clear"
          >
            <MyIcon name="lucide:x" class="text-base" />
          </Button>
        </div>
        <Button
          severity="secondary"
          variant="text"
          rounded
          class="shrink-0 !p-1 !text-slate-400 hover:!text-sky-600 dark:hover:!text-sky-400"
          aria-label="执行"
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
import type AutoComplete from 'primevue/autocomplete'
import { Parser as SqlParser } from 'node-sql-parser'

const props = defineProps<{
  selected_ids: Set<number>
  placeholder?: string
}>()

const emit = defineEmits<{
  (e: 'execute-filter', filter: string): void
  (e: 'execute-command', command: string): void
  (e: 'clear-selection'): void
}>()

const sql_parser = new SqlParser()

type AutoCompleteInstance = InstanceType<typeof AutoComplete> & {
  overlayVisible: boolean
  focusedOptionIndex: number
  show: () => void
  hide: () => void
  $refs: { focusInput: any }
}

// Suggestion lists (populated from server)
const fields = ref<string[]>([])
const sql_keywords = ref<string[]>([])
const commands = ref<string[]>([])

const ac_ref = ref<AutoCompleteInstance | null>(null)

// Must register onMounted() before the first async call
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

const { admin } = useApi()
try {
  const meta = await admin.get_keywords()
  fields.value = meta.fields
  sql_keywords.value = meta.keywords
  commands.value = [...meta.commands, 'VERIFY', 'UNVERIFY', 'PROMOTE', 'DEMOTE']
}
catch {
  commands.value = ['BAN', 'UNBAN', 'KICK', 'ALL', 'VERIFY', 'UNVERIFY', 'PROMOTE', 'DEMOTE']
}

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
  ...fields.value,
  ...sql_keywords.value,
  ...commands.value,
])

function suggestion_icon(sug: string): string {
  if (commands.value.includes(sug)) {
    return 'lucide:zap'
  }
  if (fields.value.includes(sug)) {
    return 'lucide:columns-3'
  }
  return 'lucide:code'
}

function suggestion_desc(sug: string): string {
  if (commands.value.includes(sug)) {
    return '命令'
  }
  if (fields.value.includes(sug)) {
    return '字段'
  }
  return '关键字'
}

function last_token(text: string): string {
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
  const is_command = commands.value.includes(sug)
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
  const known_command = commands.value.find(c => c.toUpperCase() === upper)
  if (known_command) {
    if ((upper === 'BAN' || upper === 'KICK' || upper === 'UNBAN' || upper === 'VERIFY' || upper === 'UNVERIFY' || upper === 'PROMOTE' || upper === 'DEMOTE') && props.selected_ids.size === 0) {
      invalid.value = true
      error_msg.value = '请先选择欲操作用户'
      return
    }
    emit('execute-command', upper)
    cmd.value = ''
    ac_ref.value?.hide?.()
    return
  }

  try {
    sql_parser.astify(`SELECT * FROM users WHERE ${val}`)
  }
  catch {
    invalid.value = true
    error_msg.value = 'SQL 语法错误'
    return
  }

  if (/;|--|\/\*/.test(val)) {
    invalid.value = true
    error_msg.value = '含有非法字符'
    return
  }

  invalid.value = false
  error_msg.value = ''
  cmd.value = ''
  ac_ref.value?.hide?.()
  emit('execute-filter', val)
}
</script>
