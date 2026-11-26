import type { AuthUser } from '@server/types/auth'
import { isDeepStrictEqual } from 'node:util'
import { ApiError } from '@server/errors/ApiError'
import { has_permission } from '@shared/permissions'
import { ADMIN_FILTER_FIELDS } from '@shared/types/user'
import sqlParser from 'node-sql-parser'

type SqlValue = string | number | boolean | null
const parser = new sqlParser.Parser()
const comparisons = new Set(['=', '!=', '<>', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE'])

function invalid_filter(): never {
  throw new ApiError(400, '筛选条件无效：仅支持可见字段的比较、AND／OR／NOT、IN、BETWEEN 和排序')
}
function record(value: unknown): Record<string, unknown> {
  if (! value || typeof value !== 'object' || Array.isArray(value))
    return invalid_filter()
  return value as Record<string, unknown>
}
function envelope(value: unknown) {
  const { where: _where, orderby: _orderby, ... rest } = record(value)
  return rest
}
const select_envelope = envelope(parser.astify('SELECT id FROM users', { database: 'MySQL' }))

/** Every caller of the user list holds 『控制台·只读』 or above, which also reads phone numbers. */
export function admin_filter_fields(viewer: AuthUser) {
  return ADMIN_FILTER_FIELDS.filter(field => field !== 'phone' || has_permission(viewer, 'admin_access', 'readonly'))
}

/** Compile only approved AST nodes; no source SQL or literal is forwarded to MySQL. */
export function compile_admin_filter(viewer: AuthUser, source = '') {
  // Bound parser work as well as the expression tree consumed below.
  if (source.length > 4096)
    return invalid_filter()
  const params: SqlValue[] = []
  if (! source.trim())
    return { where: '1=1', order_by: 'u.id DESC', params }
  let parsed: unknown
  try {
    parsed = parser.astify(`SELECT id FROM users WHERE ${source}`, { database: 'MySQL' })
  }
  catch {
    return invalid_filter()
  }
  const ast = record(parsed)
  // Reject UNION, extra statements, locks, output files and all other clauses.
  if (! isDeepStrictEqual(envelope(ast), select_envelope))
    return invalid_filter()
  const fields = new Set<string>(admin_filter_fields(viewer))
  const column = (value: unknown) => {
    const node = record(value)
    if (node.type !== 'column_ref' || typeof node.column !== 'string'
      || ! fields.has(node.column.toLowerCase()) || node.collate
      || (node.table != null && ! ['users', 'u'].includes(String(node.table).toLowerCase()))) {
      return invalid_filter()
    }
    return `u.${node.column.toLowerCase()}`
  }
  const bind = (value: SqlValue) => {
    params.push(value)
    return '?'
  }
  let nodes = 0
  function expression(value: unknown, depth = 0): string {
    if (++ nodes > 256 || depth > 32)
      return invalid_filter()
    const node = record(value)
    const child = (value: unknown) => expression(value, depth + 1)
    if (node.type === 'column_ref')
      return column(node)
    if (node.type === 'number' && typeof node.value === 'number' && Number.isFinite(node.value))
      return bind(node.value)
    if (node.type === 'bool' && typeof node.value === 'boolean')
      return bind(node.value)
    if (node.type === 'null' && node.value === null)
      return bind(null)
    if (['single_quote_string', 'double_quote_string'].includes(String(node.type)) && typeof node.value === 'string') {
      // The parser decodes control escapes but retains escaped/doubled quotes and backslashes.
      const quote = node.type === 'single_quote_string' ? '\'' : '"'
      const escaped = quote === '\'' ? /\\(['"\\])|''/g : /\\(['"\\])|""/g
      return bind(node.value.replace(escaped, (_match, char: string | undefined) => char ?? quote))
    }
    if (node.type === 'unary_expr' && node.operator === 'NOT')
      return `(NOT ${child(node.expr)})`
    // MySQL's parser represents NOT(parenthesized expression) as a function.
    if (node.type === 'function') {
      const names = record(node.name).name
      const args = record(node.args)
      if (Array.isArray(names) && names.length === 1 && String(record(names[0]).value).toUpperCase() === 'NOT'
        && args.type === 'expr_list' && Array.isArray(args.value) && args.value.length === 1 && ! node.over) {
        return `(NOT ${child(args.value[0])})`
      }
      return invalid_filter()
    }
    if (node.type !== 'binary_expr' || typeof node.operator !== 'string')
      return invalid_filter()
    const op = node.operator.toUpperCase()
    if (['AND', 'OR'].includes(op) || comparisons.has(op))
      return `(${child(node.left)} ${op} ${child(node.right)})`
    if (op === 'IS' || op === 'IS NOT') {
      const right = record(node.right)
      const literal = right.type === 'null' && right.value === null
        ? 'NULL'
        : right.type === 'bool' && typeof right.value === 'boolean' ? right.value ? 'TRUE' : 'FALSE' : null
      if (! literal)
        return invalid_filter()
      return `(${child(node.left)} ${op} ${literal})`
    }
    if (['IN', 'NOT IN', 'BETWEEN', 'NOT BETWEEN'].includes(op)) {
      const right = record(node.right)
      if (right.type !== 'expr_list' || ! Array.isArray(right.value) || ! right.value.length || right.value.length > 100)
        return invalid_filter()
      const left = child(node.left)
      const values = right.value.map(child)
      if (op.endsWith('BETWEEN')) {
        if (values.length !== 2)
          return invalid_filter()
        return `(${left} ${op} ${values.join(' AND ')})`
      }
      return `(${left} ${op} (${values.join(', ')}))`
    }
    return invalid_filter()
  }
  const where = expression(ast.where)
  const orders = ast.orderby ?? []
  if (! Array.isArray(orders) || orders.length > ADMIN_FILTER_FIELDS.length)
    return invalid_filter()
  const order_by = orders.map((value) => {
    const order = record(value)
    if (order.type != null && order.type !== 'ASC' && order.type !== 'DESC')
      return invalid_filter()
    return `${column(order.expr)} ${order.type ?? 'ASC'}`
  })
  if (! order_by.some(value => value.startsWith('u.id ')))
    order_by.push('u.id DESC')
  return { where, order_by: order_by.join(', '), params }
}
