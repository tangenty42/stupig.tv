// 从生产 MySQL dump 一份脱敏数据，供本地开发导入。凭据走环境变量，无需输入。
// 用法（在服务器或能连生产库的容器里执行）：
//   pnpm db:dump:prod > stupig_tv_dev.sql
//   pnpm db:dump:prod --gzip > stupig_tv_dev.sql.gz
// 导入本地库：
//   docker exec -i <本地mysql容器> mysql -ustupig_tv -pstupig_tv stupig_tv < stupig_tv_dev.sql
//
// 脱敏规则：
//   手机号      → 199xxxxxxxx 递增假号（保持 users.phone 唯一约束）
//   密码哈希    → 统一为 "Dev@123456" 的 Argon2id 哈希，本地所有账号同密码登录
//   IPv4 地址   → 127.0.0.1
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createGzip } from 'node:zlib'
import { load_database_config } from '@config/loader'
import { hash_password } from '@server/lib/password'

const phone_pattern = /'1\d{10}'/g
const ipv4_pattern = /'\d+\.\d+\.\d+\.\d+'/g
const users_insert = /^(?:INSERT(?: IGNORE)?|REPLACE) INTO (?:`users`|users)(?=[\s(])/i

export interface RedactState {
  phone: number
  password_hash: string
}

function redact_password_hashes(line: string, password_hash: string): string {
  const prefix = users_insert.exec(line)?.[0]
  if (! prefix)
    return line

  const header = /^\s+\(([^()]+)\) VALUES\s+/i.exec(line.slice(prefix.length))
  const columns = header?.[1]?.split(',') ?? []
  const password_index = columns.findIndex(column => column.trim().replaceAll('`', '') === 'password_hash')
  if (! header || password_index < 0)
    throw new Error('无法定位用户样本的密码列')

  // mysqldump --complete-insert keeps each tuple on the INSERT line and escapes
  // quotes and newlines inside strings. Ignore delimiters enclosed in quotes.
  const tuple_pattern = /\(((?:'(?:\\.|[^'\\])*'|[^'()])*)\)([,;])/gy
  const field_pattern = /(?:'(?:\\.|[^'\\])*'|[^',])+/g
  const header_end = prefix.length + header[0].length
  tuple_pattern.lastIndex = header_end
  const redacted = [line.slice(0, header_end)]
  for (const tuple of line.matchAll(tuple_pattern)) {
    const fields = tuple[1]!.match(field_pattern)
    if (fields?.length !== columns.length)
      break
    fields[password_index] = `'${password_hash}'`
    redacted.push(`(${fields.join(',')})${tuple[2]}`)
    if (tuple[2] === ';' && tuple.index! + tuple[0].length === line.length)
      return redacted.join('')
  }

  throw new Error('无法脱敏用户样本的密码列')
}

// JS 的 replace 不会回扫替换结果，天然免疫 "替换产物仍匹配原正则" 的死循环
export function redact_dump_line(line: string, state: RedactState): string {
  return redact_password_hashes(line, state.password_hash)
    .replace(phone_pattern, () => `'199${String(++ state.phone).padStart(8, '0')}'`)
    .replace(ipv4_pattern, `'127.0.0.1'`)
}

export function dump_command(): { command: string, args: string[], env: NodeJS.ProcessEnv } {
  const db = load_database_config()
  const env = { ... process.env, MYSQL_PWD: db.password }
  const args = ['--single-transaction', '--complete-insert', '--routines', '--triggers', '--default-character-set=utf8mb4', db.name]
  // 容器网络无法直连时显式指定；不能凭容器存在就绕过当前环境的数据库地址。
  const container = process.env.MYSQL_CONTAINER?.trim()
  if (container)
    return { command: 'docker', args: ['exec', '-i', '-e', 'MYSQL_PWD', container, 'mysqldump', `-u${db.user}`, ... args], env }
  return { command: 'mysqldump', args: ['-h', db.host, '-P', String(db.port), `-u${db.user}`, ... args], env }
}

async function main() {
  const gzip = process.argv.includes('--gzip')
  const { command, args, env } = dump_command()
  const state: RedactState = { phone: 0, password_hash: await hash_password('Dev@123456') }
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'inherit'] })
  const output = gzip ? createGzip() : null
  if (output) {
    output.pipe(process.stdout)
  }
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const redacted = redact_dump_line(line, state)
      if (! (output ? output.write(`${redacted}\n`) : process.stdout.write(`${redacted}\n`))) {
        await new Promise(resolve => (output ?? process.stdout).once('drain', resolve))
      }
    }
  }
  catch (error) {
    child.kill()
    output?.destroy()
    throw error
  }
  output?.end()
  const code = await new Promise<number>(resolve => child.on('close', resolve))
  if (code !== 0) {
    throw new Error(`${command} 退出码 ${code}`)
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  await main()
}
