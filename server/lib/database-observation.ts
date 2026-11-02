import type { Pool } from 'mysql2'
import { observe_database_wait } from './upload-observation'

const installed = new WeakSet<Pool>()

/** Hook the callback pool so execute/query and explicit promise transactions all count. */
export function observe_database_pool(pool: Pool, begin_wait = observe_database_wait) {
  if (installed.has(pool))
    return
  installed.add(pool)
  const get_connection = pool.getConnection.bind(pool)
  pool.getConnection = (callback) => {
    const finish = begin_wait()
    try {
      get_connection((error, connection) => {
        finish(!! error)
        callback(error, connection)
      })
    }
    catch (error) {
      finish(true)
      throw error
    }
  }
}
