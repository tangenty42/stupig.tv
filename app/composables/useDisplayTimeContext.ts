export interface DisplayTimeContext {
  now_ms: number
  timezone: string
}

export function useDisplayTimeContext() {
  return useState<DisplayTimeContext>('display-time-context', () => ({
    now_ms: Date.now(),
    timezone: 'UTC',
  }))
}
