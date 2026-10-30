import type { ContentDraftSnapshot, DraftCommand, DraftCommandKind, DraftLease, DraftReceipt, DraftResult } from '@shared/types/content-draft'
import type { ContentReferenceRewriteResult } from '@shared/types/content-reference'
import { settings } from '@shared/settings'
import { defineStore } from 'pinia'

interface DraftApi {
  get: (input: { id?: string, story_id?: number, lease?: DraftLease }) => Promise<DraftResult>
  acquire: (input: { id: string, expected_epoch: number, page_id: string, token: string }) => Promise<DraftResult>
  command: (input: DraftCommand) => Promise<DraftResult>
  rewrite: (story_id: number, input: { markdown: string, base_namespace_revision: number | null, base_title_revision: number | null }) => Promise<ContentReferenceRewriteResult>
}

type Phase = 'readonly' | 'acquiring' | 'editing' | 'uncertain' | 'releasing' | 'forbidden'
interface Execution { receipt?: DraftReceipt, absent?: true }

/** Uses getRandomValues rather than newer randomUUID, including supported old engines. */
export function draft_random_id(bytes = 16) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function useContentDraftStore(target: string | number | null) {
  return defineStore(`content-draft:${target ?? 'new'}`, () => {
    const markdown = ref('')
    const cloud = shallowRef<ContentDraftSnapshot | null>(null)
    const phase = ref<Phase>('readonly')
    const visible = ref(false)
    const request_pending = ref(false)
    const pending_text = ref(false)
    const action_pending = ref(false)
    const reference_pending = ref(false)
    const recovery = ref('')
    const message = ref('')
    const review = shallowRef<{ text: string, token: string } | null>(null)
    const removed = ref(false)
    const initialized = computed(() => !! cloud.value)
    const dirty = computed(() => markdown.value !== cloud.value?.markdown)
    const unconfirmed_changes = computed(() => dirty.value || pending_text.value)
    const unpublished_changes = computed(() => unconfirmed_changes.value || !! cloud.value?.unpublished_changes)
    const clock = ref(0)
    let deadline = 0
    const writable = computed(() => visible.value && phase.value === 'editing' && ! action_pending.value && ! reference_pending.value && clock.value < deadline)
    let api: DraftApi | null = null
    let current = () => false
    let apply_editor: ((before: string, result: ContentReferenceRewriteResult) => boolean) | null = null
    let lease: DraftLease | undefined
    let acquisition: Parameters<DraftApi['acquire']>[0] | null = null
    let page_id = ''
    let seq = 0
    let generation = 0
    let pending: { command: DraftCommand, text: string | undefined } | null = null
    let flight: Promise<Execution | undefined> | null = null
    let release_task: Promise<void> | null = null
    let base_namespace_revision: number | null = null
    let base_title_revision: number | null = null
    let blocked_text: string | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let expiry_timer: ReturnType<typeof setTimeout> | null = null
    let last_save_started = - Infinity
    let wake: () => Promise<unknown> = () => cycle()
    let applying = false

    const now = () => performance.now()
    function alive(owner = generation) {
      return owner === generation && current()
    }
    function stop_timer() {
      if (timer !== null)
        clearTimeout(timer)
      timer = null
    }
    function clear() {
      generation ++
      stop_timer()
      if (expiry_timer !== null)
        clearTimeout(expiry_timer)
      deadline = 0
      lease = undefined
      acquisition = null
      pending = null
      pending_text.value = false
      seq = 0
      flight = null
      release_task = null
      page_id = ''
      applying = true
      markdown.value = ''
      applying = false
      cloud.value = null
      recovery.value = ''
      review.value = null
      removed.value = false
      blocked_text = null
      message.value = ''
      phase.value = 'forbidden'
      request_pending.value = false
      action_pending.value = false
      reference_pending.value = false
    }
    function configure(client: DraftApi, is_current: () => boolean, patch?: typeof apply_editor) {
      clear()
      api = client
      current = is_current
      apply_editor = patch ?? null
      page_id = draft_random_id()
      phase.value = 'readonly'
      visible.value = false
      clock.value = now()
      return generation
    }
    function replace_text(text: string, namespace: number, title: number) {
      applying = true
      markdown.value = text
      applying = false
      base_namespace_revision = namespace
      base_title_revision = title
    }
    function lose(snapshot: ContentDraftSnapshot) {
      if (unconfirmed_changes.value && markdown.value)
        recovery.value = markdown.value
      lease = undefined
      acquisition = null
      pending = null
      pending_text.value = false
      seq = 0
      deadline = 0
      phase.value = 'readonly'
      cloud.value = snapshot
      replace_text(snapshot.markdown, snapshot.namespace_revision, snapshot.title_revision)
      message.value = recovery.value ? '编辑权已变更，未上传文字仅保留在本页恢复区' : ''
    }
    function set_deadline(snapshot: ContentDraftSnapshot, started: number) {
      clock.value = now()
      deadline = now() + Math.max(0, snapshot.lease_remaining_ms - (now() - started) - settings.app.content.draft.leaseMarginMs)
      if (expiry_timer !== null)
        clearTimeout(expiry_timer)
      expiry_timer = setTimeout(() => {
        clock.value = now()
        if (phase.value === 'editing' && clock.value >= deadline)
          phase.value = 'uncertain'
      }, Math.max(0, deadline - now()))
    }
    async function accept(result: DraftResult, started: number, sent?: typeof pending) {
      const snapshot = result.snapshot
      if (! snapshot) {
        clear()
        removed.value = true
        return
      }
      if (! snapshot.owned && lease) {
        if (result.receipt?.ok && result.receipt.kind === 'release' && sent?.text !== undefined && markdown.value === sent.text) {
          cloud.value = snapshot
          replace_text(snapshot.markdown, snapshot.namespace_revision, snapshot.title_revision)
        }
        lose(snapshot)
        return
      }
      const previous = cloud.value
      const unchanged = ! previous || (sent?.text !== undefined
        ? result.receipt?.ok === true && markdown.value === sent.text
        : markdown.value === previous.markdown)
      if (unchanged && previous && markdown.value !== snapshot.markdown && apply_editor) {
        const before = markdown.value
        let from = 0
        while (from < before.length && from < snapshot.markdown.length && before[from] === snapshot.markdown[from]) from ++
        let to = before.length
        let end = snapshot.markdown.length
        while (to > from && end > from && before[to - 1] === snapshot.markdown[end - 1]) {
          to --
          end --
        }
        applying = true
        try {
          if (! apply_editor(before, { markdown: snapshot.markdown, changes: [{ from, to, insert: snapshot.markdown.slice(from, end) }], diagnostics: [],
            namespace_revision: snapshot.namespace_revision, title_revision: snapshot.title_revision, base_namespace_revision: snapshot.namespace_revision, base_title_revision: snapshot.title_revision,
            baseline_unavailable: { namespace: false, title: false } })) {
            throw new Error('引用更新快照已变化，请重新核对草稿')
          }
        }
        finally { applying = false }
      }
      cloud.value = snapshot
      if (unchanged)
        replace_text(snapshot.markdown, snapshot.namespace_revision, snapshot.title_revision)
      if (result.receipt) {
        const receipt = result.receipt
        if (['lease_lost', 'command_order'].includes(receipt.error ?? '')) {
          lose(snapshot)
          return
        }
        seq = receipt.seq
        pending = null
        pending_text.value = false
        if (! receipt.ok) {
          message.value = receipt.message ?? '草稿操作未完成'
          if (receipt.error === 'reference_review_required' && sent?.text !== undefined && receipt.review_token)
            review.value = { text: sent.text, token: receipt.review_token }
          if (sent?.text !== undefined)
            blocked_text = sent.text
        }
        else if (sent?.text !== undefined || receipt.kind !== 'sync') {
          message.value = ''
          review.value = null
          blocked_text = null
        }
      }
      if (! snapshot.owned) {
        phase.value = 'readonly'
        return
      }
      set_deadline(snapshot, started)
      if (! unchanged && (base_namespace_revision !== snapshot.namespace_revision || base_title_revision !== snapshot.title_revision)) {
        const owner = generation
        const text = markdown.value
        reference_pending.value = true
        try {
          const result = await api!.rewrite(snapshot.story_id ?? 0, { markdown: text, base_namespace_revision, base_title_revision })
          if (! alive(owner))
            return
          if (markdown.value !== text)
            throw new Error('引用更新期间原文已变化，请重新核对草稿')
          if (! result.baseline_unavailable.namespace && ! result.baseline_unavailable.title) {
            if (apply_editor && ! apply_editor(text, result))
              throw new Error('引用更新快照已变化，请重新核对草稿')
            replace_text(result.markdown, result.namespace_revision, result.title_revision)
          }
          // A live lease still allows review of unreplayable input. Returning
          // here would strand a recovered session in uncertain forever.
        }
        finally {
          if (alive(owner))
            reference_pending.value = false
        }
      }
      clock.value = now()
      phase.value = visible.value && clock.value < deadline ? 'editing' : 'uncertain'
    }
    function make_command(kind: DraftCommandKind, confirmation?: string, expected_revision?: number) {
      const snapshot = cloud.value!
      const text = ['sync', 'release'].includes(kind) && dirty.value && (kind === 'release' || markdown.value !== blocked_text) ? markdown.value : undefined
      const command: DraftCommand = {
        id: snapshot.id, lease: { ... lease! }, seq: seq + 1, kind,
        base_namespace_revision, base_title_revision,
        ... (text !== undefined ? { markdown: text } : {}),
        ... (['publish', 'reset'].includes(kind) ? { expected_revision: expected_revision ?? snapshot.draft_revision } : {}),
        ... (confirmation ? { confirm_reference_history: confirmation } : {}),
      }
      pending = { command, text }
      pending_text.value = text !== undefined
      return pending
    }
    async function execute_one(kind: DraftCommandKind = 'sync', confirmation?: string, expected_revision?: number): Promise<Execution | undefined> {
      if (! api || ! alive() || ! cloud.value || (! visible.value && kind !== 'release'))
        return
      const owner = generation
      const started = now()
      request_pending.value = true
      try {
        if (! lease) {
          if (kind !== 'sync')
            return
          if (! acquisition) {
            const latest = await api.get({ id: cloud.value.id })
            if (! alive(owner) || ! visible.value || ! latest.snapshot)
              return
            await accept(latest, started)
            if (latest.snapshot.occupied)
              return
            acquisition = { id: latest.snapshot.id, expected_epoch: latest.snapshot.lease_epoch, page_id, token: draft_random_id(32) }
          }
          phase.value = 'acquiring'
          // An unknown acquire outcome must retry the same identity, even when
          // a tokenless read would report our own newly acquired lease as busy.
          const candidate = acquisition
          const result = await api.acquire(candidate)
          if (! alive(owner))
            return
          acquisition = null
          if (result.snapshot?.owned) {
            lease = { epoch: result.snapshot.lease_epoch, page_id: candidate.page_id, token: candidate.token }
            seq = 0
          }
          await accept(result, started)
          if (! visible.value && lease)
            set_visible(false)
          return
        }
        if (! pending && (phase.value === 'uncertain' || now() >= deadline) && kind !== 'release') {
          const latest = await api.get({ id: cloud.value.id, lease })
          if (! alive(owner))
            return
          await accept(latest, started)
          if (! lease || phase.value !== 'editing')
            return
        }
        if (! pending && kind === 'sync' && dirty.value && markdown.value !== blocked_text && ! action_pending.value && ! confirmation
          && now() - last_save_started < settings.app.content.draft.saveThrottleMs) {
          schedule()
          return
        }
        const sent = pending ?? make_command(kind, confirmation, expected_revision)
        if (sent.text !== undefined && kind === 'sync')
          last_save_started = now()
        const result = await api.command(sent.command)
        if (! alive(owner))
          return
        await accept(result, started, sent)
        return { receipt: result.receipt }
      }
      catch (error) {
        if (! alive(owner))
          return
        const status = (error as { status?: number, statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode
        if ([401, 403, 404].includes(status ?? 0)) {
          const deleting = pending?.command.kind === 'delete'
          clear()
          removed.value = status === 404
          message.value = status === 404 ? '云端草稿已删除' : '当前身份无权访问云端草稿'
          // An absent target completes deletion, including a lost delete reply.
          // This observes absence; it does not invent a stored command receipt.
          if (status === 404 && deleting)
            return { absent: true }
        }
        else {
          phase.value = 'uncertain'
          message.value = error instanceof Error ? error.message : '连接中断，已暂停编辑'
        }
        throw error
      }
      finally {
        if (alive(owner))
          request_pending.value = false
      }
    }
    function execute(kind: DraftCommandKind = 'sync', confirmation?: string, expected_revision?: number) {
      if (flight)
        return flight
      const task = execute_one(kind, confirmation, expected_revision).finally(() => {
        if (flight === task)
          flight = null
      })
      flight = task
      return task
    }
    async function cycle() {
      if (release_task)
        return release_task
      if (action_pending.value)
        return flight ?? undefined
      const owner = generation
      await execute()
      if (alive(owner) && dirty.value && phase.value === 'editing')
        schedule()
    }
    async function open(input: { id?: string, story_id?: number }) {
      const owner = generation
      const started = now()
      const result = await api!.get(input)
      if (! alive(owner))
        return
      await accept(result, started)
    }
    function schedule() {
      stop_timer()
      if (! visible.value || phase.value !== 'editing' || ! dirty.value || markdown.value === blocked_text || action_pending.value || ! alive())
        return
      const delay = Math.max(0, settings.app.content.draft.saveThrottleMs - (now() - last_save_started))
      timer = setTimeout(() => {
        timer = null
        void wake().catch(() => {})
      }, delay)
    }
    async function action(kind: 'publish' | 'reset' | 'delete', expected_revision?: number) {
      if (! writable.value || action_pending.value)
        return
      action_pending.value = true
      stop_timer()
      const owner = generation
      try {
        if (flight)
          await flight
        if (! alive(owner) || ! lease || phase.value !== 'editing')
          return
        if (kind === 'publish' && dirty.value) {
          await execute()
          if (dirty.value || pending || review.value || ! lease || phase.value !== 'editing')
            return
        }
        const result = await execute(kind, undefined, expected_revision)
        return (result?.absent === true && kind === 'delete')
          || (result?.receipt?.kind === kind && result.receipt.ok)
      }
      finally {
        if (alive(owner))
          action_pending.value = false
      }
    }
    async function confirm_review() {
      if (! review.value || review.value.text !== markdown.value || ! writable.value) {
        review.value = null
        return
      }
      const token = review.value.token
      const text = review.value.text
      const owner = generation
      action_pending.value = true
      try {
        if (flight)
          await flight
        if (! alive(owner) || markdown.value !== text || ! visible.value || ! lease)
          return
        blocked_text = null
        review.value = null
        await execute('sync', token)
      }
      finally {
        if (alive(owner))
          action_pending.value = false
      }
    }
    function set_visible(value: boolean) {
      visible.value = value
      clock.value = now()
      if (value) {
        if (! release_task)
          void cycle().catch(() => {})
        return
      }
      stop_timer()
      if (! lease || release_task)
        return
      phase.value = 'releasing'
      release_task = (async () => {
        try {
          if (flight)
            await flight
          if (pending)
            await execute('release')
          if (lease && ! pending)
            await execute('release')
        }
        catch {}
        finally {
          release_task = null
          if (visible.value && alive())
            void cycle().catch(() => {})
        }
      })()
    }
    function check_writable() {
      clock.value = now()
      if (clock.value >= deadline && phase.value === 'editing')
        phase.value = 'uncertain'
      return writable.value
    }
    function can_write_now() {
      return visible.value && phase.value === 'editing' && ! action_pending.value && ! reference_pending.value && now() < deadline
    }
    function capture_write_permit() {
      const allowed = can_write_now()
      const owner = generation
      const epoch = lease?.epoch
      return () => allowed && alive(owner) && lease?.epoch === epoch && can_write_now()
    }
    watch(markdown, () => {
      if (applying)
        return
      if (review.value?.text !== markdown.value)
        review.value = null
      if (markdown.value !== blocked_text)
        blocked_text = null
      schedule()
    }, { flush: 'sync' })
    return { markdown, cloud, phase, visible, writable, initialized, dirty, unconfirmed_changes, unpublished_changes, request_pending, action_pending, reference_pending, recovery, message, review, removed,
      configure, clear, open, cycle, action, confirm_review, set_visible, check_writable,
      can_write_now, capture_write_permit,
      owns: (owner: number) => owner === generation, set_cycle_trigger: (trigger: () => Promise<unknown>) => { wake = trigger } }
  })()
}
