import type { Pool } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { create_inventory_catalog, inventory_execute } from './inventory-catalog'

it('rejects mutations and locking/file-output reads before invoking the database', async () => {
  const execute = vi.fn(async () => [[]])
  const guarded = inventory_execute({ execute } as unknown as Pick<Pool, 'execute'>)
  for (const sql of ['DELETE FROM files', 'UPDATE files SET a=1', 'SELECT * FROM files FOR UPDATE', 'SELECT \'secret\' INTO OUTFILE \'/tmp/x\''])
    expect(() => guarded.execute(sql)).toThrow('inventory_write_rejected')
  expect(execute).not.toHaveBeenCalled()
  await guarded.execute('SELECT id FROM files WHERE name=?', ['example'])
  expect(execute).toHaveBeenCalledExactlyOnceWith('SELECT id FROM files WHERE name=?', ['example'])
})

it('retains registered uploads by exact key and upload ID, including terminal attempts', async () => {
  const execute = vi.fn().mockResolvedValue([[{ id: 'existing' }]])
  const catalog = create_inventory_catalog({ execute } as unknown as Pick<Pool, 'execute'>, { bucket: 'bucket', endpoint: 'https://oss.test' })
  expect(await catalog('content/att/file', 'upload')).toBe('registered_upload')
  expect(execute.mock.calls[0]![1]).toEqual(['content/att/file', 'upload'])
  expect(execute).toHaveBeenCalledOnce()
})

it('retains static namespaces without database work and caches a reference across versions', async () => {
  const execute = vi.fn().mockResolvedValue([[{ expected_size: 123 }]])
  const catalog = create_inventory_catalog({ execute } as unknown as Pick<Pool, 'execute'>, { bucket: 'bucket', endpoint: 'https://oss.test' })
  expect(await catalog('imgs/private.svg')).toBe('static_namespace')
  expect(execute).not.toHaveBeenCalled()
  expect(await catalog('content/att/file')).toBe('reference')
  expect(await catalog('content/att/file')).toBe('reference')
  expect(execute).toHaveBeenCalledOnce()
})

it('does not convert a schema/read failure into an unreferenced candidate', async () => {
  const error = Object.assign(new Error('private SQL message'), { code: 'ER_BAD_FIELD_ERROR' })
  const execute = vi.fn().mockRejectedValue(error)
  const catalog = create_inventory_catalog({ execute } as unknown as Pick<Pool, 'execute'>, { bucket: 'bucket', endpoint: 'https://oss.test' })
  await expect(catalog('content/att/file')).rejects.toBe(error)
})
