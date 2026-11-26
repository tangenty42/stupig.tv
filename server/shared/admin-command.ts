export const ADMIN_COMMANDS = ['BAN', 'UNBAN', 'KICK', 'ALL', 'VERIFY', 'UNVERIFY', 'PROMOTE', 'DEMOTE'] as const
export const ADMIN_FILTER_KEYWORDS = ['AND', 'OR', 'NOT', 'LIKE', 'IS', 'NULL', 'IN', 'BETWEEN', 'ORDER', 'BY', 'ASC', 'DESC'] as const

export type AdminCommand = (typeof ADMIN_COMMANDS)[number]
export type AdminUserCommand = Exclude<AdminCommand, 'ALL'>
