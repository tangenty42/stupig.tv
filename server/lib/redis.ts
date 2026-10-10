import { runtime_config } from '@config/loader'
import { Redis } from 'ioredis'
import { log_warn } from './log'

const config = runtime_config()

// One shared client; connects lazily on the first command. A cache outage
// must never break requests — callers treat command failures as a cache
// miss and fall back to the upstream source, so commands fail fast instead
// of queueing behind a dead connection.
export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password || undefined,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
})

redis.on('error', (error) => {
  log_warn('redis connection error', { error_message: error.message })
})
