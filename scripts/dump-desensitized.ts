// 从生产 MySQL dump 一份脱敏数据，供本地开发导入。凭据走 config（.env + YAML），无需输入。
// 用法（在服务器或能连生产库的容器里执行）：
//   pnpm db:dump:dev > stupig_tv_dev.sql
//   pnpm db:dump:dev --gzip > stupig_tv_dev.sql.gz
// 导入本地库：
//   docker exec -i <本地mysql容器> mysql -ustupig_tv -pstupig_tv stupig_tv < stupig_tv_dev.sql
//
// 脱敏规则：
//   手机号      → 199xxxxxxxx 递增假号（保持 users.phone 唯一约束）
//   密码哈希    → 统一为 "Dev@123456" 的 bcrypt，本地所有账号同密码登录
//   IPv4 地址   → 127.0.0.1
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createGzip } from 'node:zlib'
import { config } from '@server/shared/config'

// "Dev@123456" 的 bcrypt 哈希（bcryptjs, rounds=10）
const LOCAL_PASSWORD_HASH = '$2b$10$sT2LriomK70rzTJXync3GO0wK0ERbYBS24LrTBAv621WJ2EV/n3o6'

const phone_pattern = /'1\d{10}'/g
const bcrypt_pattern = /'\$2[aby]\$[^']*'/g
const ipv4_pattern = /'\d+\.\d+\.\d+\.\d+'/g

export interface RedactState {
  phone: number
}

// JS 的 replace 不会回扫替换结果，天然免疫 "替换产物仍匹配原正则" 的死循环
export function redact_dump_line(line: string, state: RedactState): string {
  return line
    .replace(phone_pattern, () => `'199${String(++ state.phone).padStart(8, '0')}'`)
    .replace(bcrypt_pattern, `'${LOCAL_PASSWORD_HASH}'`)
    .replace(ipv4_pattern, `'127.0.0.1'`)
}

function dump_command(): { command: string, args: string[], env: NodeJS.ProcessEnv } {
  const db = config.db
  const env = { ... process.env, MYSQL_PWD: db.password }
  const args = ['--single-transaction', '--routines', '--triggers', '--default-character-set=utf8mb4', db.name]
  // 有 docker 且目标容器存在时走 docker exec（服务器上库在容器网络里，host 不一定能直连）
  const container = process.env.MYSQL_CONTAINER ?? '1Panel-mysql'
  try {
    execFileSync('docker', ['inspect', container], { stdio: 'ignore' })
    return { command: 'docker', args: ['exec', '-i', '-e', `MYSQL_PWD=${db.password}`, container, 'mysqldump', `-u${db.user}`, ... args], env }
  }
  catch {
    return { command: 'mysqldump', args: ['-h', db.host, '-P', String(db.port), `-u${db.user}`, ... args], env }
  }
}

async function main() {
  const gzip = process.argv.includes('--gzip')
  const { command, args, env } = dump_command()
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'inherit'] })
  const state: RedactState = { phone: 0 }
  const output = gzip ? createGzip() : null
  if (output) {
    output.pipe(process.stdout)
  }
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    const redacted = redact_dump_line(line, state)
    if (! (output ? output.write(`${redacted}\n`) : process.stdout.write(`${redacted}\n`))) {
      await new Promise(resolve => (output ?? process.stdout).once('drain', resolve))
    }
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
