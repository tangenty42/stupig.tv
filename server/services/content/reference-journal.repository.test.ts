import type { Connection } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import { append_reference_journal, reference_journals_since } from './reference-journal.repository'

function database() {
  let entries: { scope_id: number, revision: number, entry_index: number, node_id: number, from_ref: string | null, to_ref: string | null, from_key: string | null, to_key: string | null, is_folder: number }[] = []
  const floors = new Map<number, number>()
  const connection = { execute: async (sql: string, values: unknown[]) => {
    const scope = Number(values[0])
    if (sql.startsWith('INSERT INTO')) {
      for (let index = 0; index < values.length; index += 9) {
        const [scope_id, revision, entry_index, node_id, from_ref, to_ref, from_key, to_key, is_folder] = values.slice(index, index + 9)
        entries.push({ scope_id: Number(scope_id), revision: Number(revision), entry_index: Number(entry_index), node_id: Number(node_id), from_ref: from_ref as string | null, to_ref: to_ref as string | null, from_key: from_key as string | null, to_key: to_key as string | null, is_folder: Number(is_folder) })
      }
      return [{ affectedRows: values.length / 9 }]
    }
    if (sql.startsWith('SELECT DISTINCT')) {
      const revisions = [... new Set(entries.filter(row => row.scope_id === scope).map(row => row.revision))].sort((a, b) => b - a)
      return [revisions.slice(Number(values[1]), Number(values[1]) + 1).map(revision => ({ revision }))]
    }
    if (sql.startsWith('UPDATE')) {
      floors.set(sql.includes('content_title_namespace') ? 0 : Number(values[1]), Number(values[0]))
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('DELETE')) {
      entries = entries.filter(row => row.scope_id !== scope || row.revision > Number(values[1]))
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('SELECT revision'))
      return [entries.filter(row => row.scope_id === scope && row.revision > Number(values[1]) && row.revision <= Number(values[2])).sort((a, b) => a.revision - b.revision || a.entry_index - b.entry_index)]
    throw new Error(`Unexpected SQL: ${sql}`)
  } } as unknown as Connection
  return { connection, floors, entries: () => entries }
}

describe('bounded reference journals', () => {
  it.each([0, 7])('retains 200 whole batches in scope %s, regardless of entry count and revision gaps', async (scope) => {
    const db = database()
    const scheme = scope === 0 ? 'content://' : 'att://'
    await append_reference_journal(db.connection, 9, 1, [{ node_id: 1, from: 'att://other', to: null }])
    for (let batch = 1; batch <= 201; batch ++) {
      await append_reference_journal(db.connection, scope, batch * 2, Array.from({ length: batch === 2 ? 300 : 1 }, (_, index) => ({ node_id: index + 1, from: `${scheme}Old${index}`, to: `${scheme}New${index}` })))
    }
    expect(db.floors.get(scope)).toBe(2)
    const retained = db.entries().filter(row => row.scope_id === scope)
    expect(new Set(retained.map(row => row.revision)).size).toBe(200)
    expect(retained[0]).toMatchObject({ revision: 4 })
    expect(retained.filter(row => row.revision === 4)).toHaveLength(300)
    if (scope === 0)
      expect((await reference_journals_since(db.connection, scope, 2, 402, 2)).journals).toHaveLength(200)
    else
      await expect(reference_journals_since(db.connection, scope, 2, 402, 2)).rejects.toMatchObject({ statusCode: 503 })
    expect((await reference_journals_since(db.connection, scope, 0, 402, 2)).unavailable).toBe(true)
    expect(db.entries().filter(row => row.scope_id === 9)).toHaveLength(1)
  })

  it.each([[2, 3], [1, 3], [1, 2], []])('rejects incomplete attachment history with retained revisions %j', async (... revisions) => {
    const db = database()
    for (const revision of revisions)
      await append_reference_journal(db.connection, 3, revision, [])
    await expect(reference_journals_since(db.connection, 3, 0, 3, 0)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('allows an already current baseline without reading any older batches', async () => {
    const db = database()
    expect(await reference_journals_since(db.connection, 3, 3, 3, 0)).toEqual({ unavailable: false, journals: [] })
  })

  it('records canonical keys while retaining actual target spelling, and reads empty batches', async () => {
    const db = database()
    await append_reference_journal(db.connection, 3, 1, [{ node_id: 1, from: 'ATT://E\u0301.PNG', to: 'att://Photo.PNG' }])
    await append_reference_journal(db.connection, 3, 2, [])
    expect(db.entries()[0]).toMatchObject({ from_key: 'att://é.png', to_key: 'att://photo.png', to_ref: 'att://Photo.PNG' })
    expect((await reference_journals_since(db.connection, 3, 0, 2, 0)).journals).toEqual([
      { revision: 1, changes: [{ node_id: 1, from: 'ATT://E\u0301.PNG', to: 'att://Photo.PNG', is_folder: false }] },
      { revision: 2, changes: [] },
    ])
  })
})
