import type { Connection } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'
import { assert_inventory_endpoint, build_inventory, inventory_arguments, inventory_report, InventoryScanError, read_inventory } from './legacy-folder-image-inventory'

describe('legacy folder image inventory', () => {
  it('requires a single explicit environment and only pins local endpoints when requested', () => {
    expect(() => inventory_arguments([])).toThrow('explicit_environment_required')
    expect(() => inventory_arguments(['--env=dev', '--env=prod'])).toThrow('duplicate_environment')
    expect(() => inventory_arguments(['--env=dev', '--apply'])).toThrow('unknown_inventory_argument')
    expect(inventory_arguments(['--env', 'prod'])).toEqual({ environment: 'production', expected_local_port: undefined })
    expect(inventory_arguments(['--env=dev', '--expect-local-port=3306'])).toEqual({ environment: 'development', expected_local_port: 3306 })
    expect(() => assert_inventory_endpoint({ host: '127.0.0.1', port: 3307 }, 3306)).toThrow('inventory_endpoint_mismatch')
    expect(() => assert_inventory_endpoint({ host: 'remote.example', port: 3306 }, 3306)).toThrow('inventory_endpoint_mismatch')
    expect(() => assert_inventory_endpoint({ host: 'remote.example', port: 3306 })).not.toThrow()
  })

  it('uses one read-only consistent transaction and fetches no signed or object-key fields', async () => {
    const statements: string[] = []
    const query = vi.fn(async (sql: string) => {
      statements.push(sql)
      return [[{ database_name: 'fixture', read_at: '2026-11-24 12:00:00' }], []]
    })
    const execute = vi.fn(async (sql: string) => {
      statements.push(sql)
      return [[], []]
    })
    const rollback = vi.fn(async () => {})
    const result = await read_inventory({ query, execute, rollback } as unknown as Connection)
    expect(result.database).toBe('fixture')
    expect(statements.slice(0, 3)).toEqual(['SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'SET SESSION TRANSACTION READ ONLY', 'START TRANSACTION WITH CONSISTENT SNAPSHOT'])
    expect(statements.slice(3).every(sql => sql.startsWith('SELECT '))).toBe(true)
    expect(statements.join('\n')).not.toMatch(/object_key|signed|url|FOR UPDATE|FOR SHARE/)
    expect(rollback).toHaveBeenCalledOnce()
  })

  it('shares the current catalog with bound drafts, mirrors API MIME fallback, and reports only reference snippets', () => {
    const body = 'Private prose must stay outside the report.\n![](att://cards)'
    const result = build_inventory({
      published: [{ id: 7, markdown: body }],
      drafts: [{ id: 'bound', story_id: 7, markdown: body }, { id: 'unbound', story_id: null, markdown: body }],
      attachments: [
        { story_id: 7, parent_id: 0, file_name: '', is_folder: 1, mime_type: null },
        { story_id: 7, parent_id: 1, file_name: 'cards', is_folder: 1, mime_type: null },
        { story_id: 7, parent_id: null, file_name: 'cards/2.png', is_folder: 0, mime_type: null },
        { story_id: 7, parent_id: 2, file_name: 'cards/1.jpg', is_folder: 0, mime_type: 'text/plain' },
        { story_id: 7, parent_id: 0, file_name: 'cards/10.bin', is_folder: 0, mime_type: 'image/png' },
      ],
    })
    expect(result.findings.map(item => item.reference.kind)).toEqual(['images', 'images', 'missing'])
    expect(result.findings[0]?.reference.replacement).toBe('<carousel>![](att://cards/2.png)![](att://cards/10.bin)</carousel>')
    const report = inventory_report('development', 'fixture', '2026-11-24 12:00:00', result)
    expect(report).toContain('完整扫描正式版 1 份、云端草稿 2 份')
    expect(report).toContain('第 2 行')
    expect(report).not.toContain('Private prose')
    expect(report).not.toContain('cards/1.jpg')
    expect(report).toContain('未绑定')
  })

  it('fails coverage with the affected document location when any scan throws', () => {
    try {
      build_inventory({ published: [], drafts: [{ id: 'broken', story_id: null, markdown: 'private malformed text' }], attachments: [] }, () => {
        throw new Error('private malformed text')
      })
      throw new Error('expected scan failure')
    }
    catch (error) {
      expect(error).toBeInstanceOf(InventoryScanError)
      expect((error as InventoryScanError).document).toEqual({ kind: 'draft', id: 'broken', story_id: null })
      expect((error as Error).message).not.toContain('private malformed text')
    }
  })
})
