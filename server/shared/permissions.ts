// 权限定义。每个权限项的 field 是写入用户 permissions 列表的字段名；
// 默认不授予任何权限；is_admin 用户等价于全部权限，其 permissions 列表保持为空。
export interface PermissionLevelDefinition {
  level: string
  name: string
  description: string
}

export interface PermissionDefinition {
  field: string
  name: string
  description: string
  /** 按权限从低到高排列，高级别蕴含低级别 */
  levels: readonly PermissionLevelDefinition[]
}

export const PERMISSIONS = [
  {
    field: 'admin_access',
    name: '控制台',
    description: '访问控制台、以管理员身份访问用户主页',
    levels: [
      { level: 'readonly', name: '只读', description: '可查看用户列表、读取用户主页私密信息' },
      { level: 'full', name: '完全', description: '允许对用户的任何管理操作' },
    ],
  },
  {
    field: 'content_manage',
    name: '『蠢猪档案』管理后台',
    description: '创建、编辑、删除『蠢猪档案』',
    levels: [
      { level: 'full', name: '完全', description: '允许对『蠢猪档案』的任何管理操作' },
    ],
  },
  {
    field: 'content_private',
    name: '『蠢猪档案』机密',
    description: '查看『蠢猪档案』完整的机密内容、附件',
    levels: [
      { level: 'read', name: '可读', description: '查看『蠢猪档案』完整的机密内容、附件' },
    ],
  },
] as const satisfies PermissionDefinition[]

export type PermissionField = (typeof PERMISSIONS)[number]['field']
export type PermissionLevel = (typeof PERMISSIONS)[number]['levels'][number]['level']

export interface PermissionGrant {
  field: PermissionField
  level: PermissionLevel
}

export function get_permission_definition(field: string) {
  return PERMISSIONS.find(item => item.field === field)
}

export function is_valid_permission_grant(field: string, level: string) {
  const definition = get_permission_definition(field)
  return !! definition && definition.levels.some(item => item.level === level)
}

function level_rank(field: string, level: string) {
  const definition = get_permission_definition(field)
  return definition ? definition.levels.findIndex(item => item.level === level) : - 1
}

export function permission_grant_covers(grant: PermissionGrant, field: PermissionField, level: PermissionLevel) {
  return grant.field === field && level_rank(grant.field, grant.level) >= level_rank(field, level)
}

export function has_permission(
  source: { is_admin?: boolean, permissions?: readonly PermissionGrant[] | null } | null | undefined,
  field: PermissionField,
  level: PermissionLevel,
) {
  if (! source) {
    return false
  }
  if (source.is_admin) {
    return true
  }
  return (source.permissions ?? []).some(grant => permission_grant_covers(grant, field, level))
}

// 解析数据库 / cookie 中的 JSON 值：过滤未知项，同一 field 只保留最高级别。
export function normalize_permission_grants(input: unknown): PermissionGrant[] {
  if (! Array.isArray(input)) {
    return []
  }

  const by_field = new Map<string, PermissionGrant>()
  for (const raw of input) {
    if (! raw || typeof raw !== 'object') {
      continue
    }
    const { field, level } = raw as { field?: unknown, level?: unknown }
    if (typeof field !== 'string' || typeof level !== 'string' || ! is_valid_permission_grant(field, level)) {
      continue
    }
    const existing = by_field.get(field)
    if (! existing || level_rank(field, level) > level_rank(existing.field, existing.level)) {
      by_field.set(field, { field: field as PermissionField, level: level as PermissionLevel })
    }
  }
  return [... by_field.values()]
}

export function resolve_permission_grant(grant: PermissionGrant) {
  const definition = get_permission_definition(grant.field)
  const level = definition?.levels.find(item => item.level === grant.level)
  return {
    name: definition?.name ?? grant.field,
    description: definition?.description ?? '',
    level_name: level?.name ?? grant.level,
  }
}
