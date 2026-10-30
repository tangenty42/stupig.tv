// Match the original 300ms CSS `ease` transition without registered properties.
// Solve the time axis of cubic-bezier(.25, .1, .25, 1), then read its value axis.
function ease(progress: number) {
  let low = 0
  let high = 1
  for (let step = 0; step < 16; step ++) {
    const t = (low + high) / 2
    const x = 0.75 * t * (1 - t) ** 2 + 0.75 * t ** 2 * (1 - t) + t ** 3
    if (x < progress)
      low = t
    else
      high = t
  }
  const t = (low + high) / 2
  return 0.3 * t * (1 - t) ** 2 + 3 * t ** 2 * (1 - t) + t ** 3
}

/** Retarget from the current sample; disposal must not write to retired DOM. */
export function carousel_motion(initial: number[], apply: (values: number[]) => void) {
  let from = [... initial]
  let current = [... initial]
  let target = [... initial]
  let started = 0
  let frame: number | undefined
  const stop = () => {
    if (frame !== undefined)
      cancelAnimationFrame(frame)
    frame = undefined
  }
  const sample = (now: number) => {
    const progress = Math.min(Math.max((now - started) / 300, 0), 1)
    const amount = ease(progress)
    current = progress === 1 ? [... target] : from.map((value, index) => value + (target[index]! - value) * amount)
    apply(current)
    return progress < 1
  }
  const tick = (now: number) => {
    frame = undefined
    if (sample(now))
      frame = requestAnimationFrame(tick)
  }
  return {
    set(values: number[], immediate = false) {
      if (! immediate && values.every((value, index) => value === target[index]))
        return
      if (frame !== undefined && ! immediate)
        sample(performance.now())
      stop()
      target = [... values]
      if (immediate) {
        current = [... target]
        apply(current)
        return
      }
      from = [... current]
      started = performance.now()
      frame = requestAnimationFrame(tick)
    },
    stop,
  }
}
