type Stage = 'total' | 'source' | 'resume' | 'initialize' | 'checking' | 'bytes' | 'seal' | 'await_completion' | 'adopt' | 'dom_update'
type Outcome = 'returned' | 'failed' | 'stopped'
type Timeline = Pick<Performance, 'mark' | 'measure' | 'clearMarks' | 'clearMeasures'>
const retained = new WeakMap<Timeline, { name: string, owner: Set<string> }[]>()
let sequence = 0

/** Local DevTools measurements only, using the mark/measure API supported by Safari 13. */
export function create_upload_timeline(id: string, api: Timeline | undefined = typeof window === 'undefined' ? undefined : window.performance, on_idle: () => void = () => {}) {
  const prefix = `content.upload.${id}.${++ sequence}`
  const active = new Map<string, { stage: Stage, first: string, name: string }>()
  const owned = new Set<string>()
  let disposed = false
  let completed = false
  let calls = 0
  const safe = (action: () => void) => {
    try {
      action()
    }
    catch { /* Browser diagnostics cannot affect upload or publication. */ }
  }
  function idle() {
    if (completed && ! active.size && ! disposed) {
      disposed = true
      safe(on_idle)
    }
  }
  function begin(stage: Stage, key: string) {
    if (! api || disposed || active.has(key) || ! /^[\da-f]{32}$/.test(id))
      return
    const name = key === stage ? `${prefix}.${stage}` : `${prefix}.${key}.${stage}`
    const mark = `${name}.start`
    safe(() => {
      api.mark(mark)
      active.set(key, { stage, first: mark, name })
    })
  }
  function end(key: string, outcome: Outcome) {
    const entry = active.get(key)
    if (! api || ! entry)
      return
    const { first } = entry
    active.delete(key)
    const name = `${entry.name}.${outcome}`
    const last = `${entry.name}.end`
    safe(() => {
      try {
        api.mark(last)
        api.measure(name, first, last)
        owned.add(name)
        const history = retained.get(api) ?? []
        history.push({ name, owner: owned })
        retained.set(api, history)
        while (history.length > 128) {
          const oldest = history.shift()!
          oldest.owner.delete(oldest.name)
          api.clearMeasures(oldest.name)
        }
      }
      finally {
        api.clearMarks(first)
        api.clearMarks(last)
      }
    })
    idle()
  }
  function start(stage: Stage) {
    begin(stage, stage)
  }
  function finish(stage: Stage, outcome: Outcome = 'returned') {
    end(stage, outcome)
  }
  function stop(outcome: Outcome = 'stopped') {
    completed = true
    for (const key of [... active.keys()])
      end(key, outcome)
    idle()
    disposed = true
  }
  function complete() {
    completed = true
    finish('dom_update')
    finish('total')
    idle()
  }
  function dispose() {
    disposed = true
    for (const { first } of active.values())
      safe(() => api?.clearMarks(first))
    active.clear()
    for (const name of owned)
      safe(() => api?.clearMeasures(name))
    if (api)
      retained.set(api, (retained.get(api) ?? []).filter(item => ! owned.has(item.name)))
    owned.clear()
  }
  async function measure<T>(stage: Stage, action: () => Promise<T>) {
    const key = `call${++ calls}`
    begin(stage, key)
    try {
      const result = await action()
      end(key, 'returned')
      return result
    }
    catch (error) {
      end(key, 'failed')
      throw error
    }
  }
  return { start, finish, stop, complete, dispose, measure }
}
