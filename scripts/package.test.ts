import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// 幽灵依赖守卫：package.json 脚本里调用的 CLI，必须是自己声明过的依赖。
//
// 教训：`maintenance:build` 曾经直接调 esbuild，而 esbuild 只是 vite 的传递依赖。
// 本地 node_modules/.bin 恰好有它的残留 shim，Docker 里干净安装却没有 —— 构建到
// 第 7 层才炸 `esbuild: not found`。
//
// 判定依据刻意选 node_modules/.bin：那正是 `pnpm run` 解析命令的地方。出现在
// .bin 里却不在 dependencies 里的命令，就是幽灵依赖——pnpm 会（不保证稳定地）
// 把部分传递依赖提升进 .bin，所以"本地能跑"不等于"装得出来"。
//
// 已知盲区：若某个 CLI 连本地 .bin 里都没有，本测试无从判断它属于哪个包，会放过。
// 那种情况本地也跑不起来，会在别处立刻暴露。
//
// 放在 scripts/ 而非仓库根：根目录的任何 TS 文件都不属于任何 tsconfig 项目（根
// tsconfig 是 files: [] 的 solution），编辑器会退化成无 node 类型的推断项目而报错。
// scripts/tsconfig.json 是唯一声明了 types: ["node"] 的项目。
const project_root = resolve(import.meta.dirname, '..')

function read_package_json(): {
  scripts: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
} {
  return JSON.parse(readFileSync(resolve(project_root, 'package.json'), 'utf-8'))
}

/** 按 shell 的语义切出各条命令，引号内的 && ; | 不算分隔符 */
export function split_commands(script: string): string[] {
  const commands: string[] = []
  let current = ''
  let quote: string | null = null
  for (let index = 0; index < script.length; index ++) {
    const char = script[index]
    if (quote) {
      if (char === quote) {
        quote = null
      }
      current += char
      continue
    }
    if (char === '\'' || char === '"') {
      quote = char
      current += char
      continue
    }
    if (script.startsWith('&&', index) || script.startsWith('||', index)) {
      commands.push(current)
      current = ''
      index ++
      continue
    }
    if (char === ';' || char === '|') {
      commands.push(current)
      current = ''
      continue
    }
    current += char
  }
  commands.push(current)
  return commands.map(command => command.trim()).filter(Boolean)
}

/** 一条命令真正要执行的程序名：跳过 `VAR=value` 这类前置赋值 */
export function command_name(command: string): string | null {
  const tokens = command.split(/\s+/).filter(Boolean)
  const executable = tokens.find(token => ! /^[A-Z_]\w*=/i.test(token))
  return executable ?? null
}

function declared_packages(pkg: ReturnType<typeof read_package_json>): Set<string> {
  return new Set([
    ... Object.keys(pkg.dependencies ?? {}),
    ... Object.keys(pkg.devDependencies ?? {}),
    ... Object.keys(pkg.optionalDependencies ?? {}),
    ... Object.keys(pkg.peerDependencies ?? {}),
  ])
}

describe('split_commands', () => {
  it('按 && 和 ; 切分', () => {
    expect(split_commands('a && b; c')).toEqual(['a', 'b', 'c'])
  })

  it('引号里的分隔符不算切分点', () => {
    // maintenance:build 的 --banner:js="...; ..." 就踩这条
    expect(split_commands('esbuild --banner:js="const a; const b" && node x.js'))
      .toEqual(['esbuild --banner:js="const a; const b"', 'node x.js'])
  })

  it('trap 的引号参数不切分', () => {
    expect(split_commands('trap \'rm -f x\' EXIT; node y.mjs'))
      .toEqual(['trap \'rm -f x\' EXIT', 'node y.mjs'])
  })
})

describe('command_name', () => {
  it('跳过前置环境变量赋值', () => {
    expect(command_name('PORT=3042 node .output/server/index.mjs')).toBe('node')
  })

  it('普通命令取第一个词', () => {
    expect(command_name('esbuild scripts/a.ts --outfile=x')).toBe('esbuild')
  })
})

describe('package.json 脚本', () => {
  const pkg = read_package_json()
  const declared = declared_packages(pkg)
  const bin_dir = resolve(project_root, 'node_modules/.bin')
  const available_bins = new Set(readdirSync(bin_dir))

  it('脚本里调用的每个 CLI 都是已声明的依赖', () => {
    const offenders = new Set<string>()
    for (const [name, script] of Object.entries(pkg.scripts)) {
      for (const command of split_commands(script)) {
        const executable = command_name(command)
        if (executable && available_bins.has(executable) && ! declared.has(executable)) {
          offenders.add(`${name}: ${executable}`)
        }
      }
    }
    expect([... offenders]).toEqual([])
  })

  it('脚本不依赖 shell 变量展开（Windows 上脚本跑在 cmd.exe 里，不会展开）', () => {
    // 教训：dev 曾经是 `nuxt dev --host 0.0.0.0 --port ${APP_PORT}`，start 曾经是
    // `PORT=${APP_PORT} node ...`。cmd.exe 只认 %VAR%，而 pnpm 脚本的环境里本来
    // 就没有 .env，所以 ${APP_PORT} 永远原样传下去：Nuxt 拿到字面量、Number() 得到
    // NaN，get-port-please 把它丢掉后回落到 3000 —— 端口静默变成 3000 而不是 .env
    // 里的 3042。dev 端口现在由 nuxt.config 的 devServer 读 APP_PORT（见该处注释），
    // 生产端口由 compose 注入的 PORT 决定，脚本不再参与。
    const offenders = Object.entries(pkg.scripts)
      .filter(([, script]) => /\$\{/.test(script))
      .map(([name]) => name)
    expect(offenders).toEqual([])
  })

  it('守卫本身有效：这个检查能认出幽灵依赖', () => {
    // 用一个确实存在于 .bin 且未声明的命令自检，否则测试可能在空转
    const phantom = [... available_bins].find(bin => ! declared.has(bin))
    expect(phantom, '本地 .bin 里应当存在未声明的传递依赖，否则此守卫测不出东西').toBeDefined()
    expect(available_bins.has('esbuild')).toBe(true)
    expect(declared.has('esbuild')).toBe(true)
  })
})
