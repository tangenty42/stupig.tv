import type { create_background_runner } from './runner'

const runners = new Set<Pick<ReturnType<typeof create_background_runner>, 'wake'>>()

/** Local hints only; durable ledgers and periodic sweeps remain authoritative. */
export function register_background_wakeup(runner: Pick<ReturnType<typeof create_background_runner>, 'wake'>) {
  runners.add(runner)
  return () => {
    runners.delete(runner)
  }
}

export function wake_background(id: string) {
  for (const runner of runners)
    runner.wake(id)
}
