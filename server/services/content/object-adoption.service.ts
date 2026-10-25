import type { Connection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'

/** Hold these locks through publication. A completed retirement is a permanent tombstone. */
export async function require_adoptable_objects(connection: Pick<Connection, 'execute'>, keys: (string | null | undefined)[]) {
  for (const key of [... new Set(keys.filter((key): key is string => !! key))].sort()) {
    const [rows] = await connection.execute<RowDataPacket[]>('SELECT object_key FROM content_object_retirements WHERE object_key = ? FOR UPDATE', [key])
    if (rows.length)
      throw new ApiError(409, '附件对象已进入退役流程，请重新上传')
  }
}
