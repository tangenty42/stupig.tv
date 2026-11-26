import { describe, expect, it } from 'vitest'
import { has_permission, is_valid_permission_grant, normalize_permission_grants } from './permissions'

describe('permission levels', () => {
  it('lets the higher level of one permission include the lower one', () => {
    const manager = { permissions: [{ field: 'content_access', level: 'full' }] } as const
    expect(has_permission(manager, 'content_access', 'full')).toBe(true)
    expect(has_permission(manager, 'content_access', 'private_read')).toBe(true)
    const reader = { permissions: [{ field: 'content_access', level: 'private_read' }] } as const
    expect(has_permission(reader, 'content_access', 'private_read')).toBe(true)
    expect(has_permission(reader, 'content_access', 'full')).toBe(false)
    expect(has_permission(reader, 'admin_access', 'readonly')).toBe(false)
  })

  it('keeps the full console level to administrators, even against a stored grant', () => {
    expect(is_valid_permission_grant('admin_access', 'readonly')).toBe(true)
    expect(is_valid_permission_grant('admin_access', 'full')).toBe(false)
    const stale = { is_admin: false, permissions: [{ field: 'admin_access', level: 'full' }] } as const
    expect(has_permission(stale, 'admin_access', 'full')).toBe(false)
    expect(has_permission(stale, 'admin_access', 'readonly')).toBe(false)
    expect(normalize_permission_grants(stale.permissions)).toEqual([])
    const admin = { is_admin: true, permissions: [] }
    expect(has_permission(admin, 'admin_access', 'full')).toBe(true)
    expect(has_permission(admin, 'content_access', 'full')).toBe(true)
  })

  it('drops retired and unknown grants and keeps the highest level per permission', () => {
    expect(normalize_permission_grants([
      { field: 'content_manage', level: 'full' },
      { field: 'content_private', level: 'read' },
      { field: 'content_access', level: 'private_read' },
      { field: 'content_access', level: 'full' },
      { field: 'admin_access', level: 'readonly' },
      { field: 'content_access', level: 'bogus' },
      null,
    ])).toEqual([{ field: 'content_access', level: 'full' }, { field: 'admin_access', level: 'readonly' }])
  })
})
