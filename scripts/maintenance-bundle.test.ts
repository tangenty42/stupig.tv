import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'

const run = promisify(execFile)

// 对构建产物的集成测试：维护脚本靠 esbuild 的别名 + createRequire banner 打成
// 自包含单文件，才会被塞进运行时镜像（那里没有源码、没有 tsx、没有 node_modules）。
// 这两处配置一旦被改坏，编译照过、本地照跑，只有生产 cron 会炸，所以在工作区之外
// 真的构建并运行一次产物。
const project_root = resolve(import.meta.dirname, '..')
const work_dir = resolve(tmpdir(), 'stupig-maintenance-bundle-test')
const build_output = resolve(project_root, '.output/server/maintenance/cleanup.mjs')
const bundle = resolve(work_dir, 'cleanup.mjs')

beforeAll(async () => {
  await rm(work_dir, { recursive: true, force: true })
  await mkdir(work_dir, { recursive: true })
  await cp(resolve(project_root, 'config'), resolve(work_dir, 'config'), { recursive: true })
  // 指向一个必然拒连的端口：不碰数据库也能确认"已经走到建连"
  await writeFile(resolve(work_dir, 'config/local.yaml'), 'db:\n  host: 127.0.0.1\n  port: 1\n')
  if (process.platform === 'win32') {
    await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm maintenance:build'], { cwd: project_root })
  }
  else {
    await run('pnpm', ['maintenance:build'], { cwd: project_root })
  }
  await cp(build_output, bundle)
}, 120_000)

describe('维护脚本产物', () => {
  it('脱离工作区（无 node_modules）也能加载并走到建连', async () => {
    const env = {
      ... process.env,
      NODE_ENV: 'production',
      DB_PASSWORD: 'placeholder',
      JWT_SECRET: 'p'.repeat(40),
      ALIYUN_ACCESS_KEY_ID: 'placeholder',
      ALIYUN_ACCESS_KEY_SECRET: 'placeholder',
      OSS_ACCESS_KEY_ID: 'placeholder',
      OSS_ACCESS_KEY_SECRET: 'placeholder',
    }

    let failure: { stderr?: string, stdout?: string } | undefined
    try {
      await run(process.execPath, [bundle], { cwd: work_dir, env })
    }
    catch (error) {
      failure = error as typeof failure
    }

    // 连不上库是预期结果：端口 1 必然拒绝
    expect(failure?.stderr).toMatch(/ECONNREFUSED/)
    // 反过来，不能是打包漏了东西（模块解析失败 / ESM 里残留 CJS require）
    expect(failure?.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Dynamic require|Cannot find module/)
  }, 60_000)

  it('产物不依赖源码目录里的任何东西', async () => {
    const source = await readFile(bundle, 'utf-8')
    // 别名指向的是打包期路径，不该以 import 形式留在产物里
    expect(source).not.toMatch(/from ["']@(server|shared)\//)
  })

  it('迁移产物同样能在容器里跑起来（只读 --status，不写库）', async () => {
    const env = {
      ... process.env,
      NODE_ENV: 'production',
      DB_PASSWORD: 'placeholder',
      JWT_SECRET: 'p'.repeat(40),
      ALIYUN_ACCESS_KEY_ID: 'placeholder',
      ALIYUN_ACCESS_KEY_SECRET: 'placeholder',
      OSS_ACCESS_KEY_ID: 'placeholder',
      OSS_ACCESS_KEY_SECRET: 'placeholder',
    }
    const migrate = resolve(work_dir, 'migrate.mjs')
    await cp(resolve(project_root, '.output/server/maintenance/migrate.mjs'), migrate)

    let failure: { stderr?: string, stdout?: string } | undefined
    try {
      // temp 目录里没有 migrations/，也没有可连接的库，但两件事都不该是模块加载错误
      await run(process.execPath, [migrate, '--status'], { cwd: work_dir, env })
    }
    catch (error) {
      failure = error as typeof failure
    }

    // 断言必须拒连：既证明产物真的走到了建连，也保证这个测试永远不会连上真库
    expect(failure?.stderr).toMatch(/ECONNREFUSED/)
    expect(failure?.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Dynamic require|Cannot find module/)
  }, 60_000)
})
