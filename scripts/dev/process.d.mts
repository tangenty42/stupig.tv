import type { SpawnOptions } from 'node:child_process'

/** Small owned-child boundary used by the runner and its lifecycle tests. */
export function supervise_child(command: string, args: string[], options?: {
  spawn?: (command: string, args: string[], options: SpawnOptions) => {
    once: (event: string, listener: () => void) => unknown
    kill: () => unknown
  }
  env?: NodeJS.ProcessEnv
  onExit?: () => void
  retryMs?: number
}): () => void
