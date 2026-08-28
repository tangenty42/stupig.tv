import { env } from '@shared/env'
import { Redis } from 'ioredis'

// One shared client; connects lazily on the first command. A cache outage
// must never break requests — callers treat command failures as a cache
// miss and fall back to the upstream source, so commands fail fast instead
// of queueing behind a dead connection.
export const redis = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
})

redis.on('error', (error) => {
  console.warn('[redis] connection error:', error.message)
})
