import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { build_migration_scripts } from './build'
import { load_script, read_migrations } from './catalog'
import { package_native_runtime } from './native'

const run = promisify(execFile)

// 对构建产物的集成测试：维护脚本靠 esbuild 的别名 + createRequire banner 打成
// 自包含单文件，才会被塞进运行时镜像（那里没有源码、没有 tsx、没有 node_modules）。
// 这两处配置一旦被改坏，编译照过、本地照跑，只有生产 cron 会炸，所以在工作区之外
// 真的构建并运行一次产物。
const project_root = resolve(import.meta.dirname, '../..')
const work_dir = resolve(tmpdir(), 'stupig-maintenance-bundle-test')
const build_output = resolve(project_root, '.output/server/maintenance/cleanup.mjs')
const bundle = resolve(work_dir, 'cleanup.mjs')

beforeAll(async () => {
  await rm(work_dir, { recursive: true, force: true })
  await mkdir(work_dir, { recursive: true })
  await cp(resolve(project_root, 'config'), resolve(work_dir, 'config'), { recursive: true })
  if (process.platform === 'win32') {
    await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm maintenance:build'], { cwd: project_root })
  }
  else {
    await run('pnpm', ['maintenance:build'], { cwd: project_root })
  }
  await cp(build_output, bundle)
}, 120_000)

// Production bundles run without source files or node_modules; config files are shipped separately.
const bundle_env = {
  NODE_ENV: 'production',
  MYSQL_HOST: '127.0.0.1',
  MYSQL_PORT: '1',
  MYSQL_PASSWORD: 'placeholder',
  MYSQL_USER: 'stupig_tv',
  MYSQL_DATABASE: 'stupig_tv',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '1',
  MQTT_HOST: '127.0.0.1',
  MQTT_TCP_PORT: '1',
  MQTT_WEB_URL: 'ws://localhost:8083/mqtt',
  NUXT_OTP_DEBUG: 'false',
  JWT_SECRET: 'p'.repeat(40),
  ALIYUN_DYPNS_ACCESS_KEY_ID: 'placeholder',
  ALIYUN_DYPNS_ACCESS_KEY_SECRET: 'placeholder',
  ALIYUN_DYPNS_CAPTCHA_APP_KEY: 'placeholder',
  ALIYUN_OSS_ACCESS_KEY_ID: 'aliyun-oss-id',
  ALIYUN_OSS_ACCESS_KEY_SECRET: 'aliyun-oss-secret',
  OSS_PUBLIC_ACCESS_KEY_ID: 'public-id',
  OSS_PUBLIC_ACCESS_KEY_SECRET: 'public-secret',
  OSS_PRIVATE_ACCESS_KEY_ID: 'private-id',
  OSS_PRIVATE_ACCESS_KEY_SECRET: 'private-secret',
}

describe('维护脚本产物', () => {
  it('图片迁移携带完整原生依赖，在工作区外编码 AVIF，并拒绝原生文件改动', async () => {
    const { writeFile } = await import('node:fs/promises')
    const root = resolve(work_dir, 'native')
    const dir = resolve(root, 'migrations')
    await mkdir(dir, { recursive: true })
    await writeFile(resolve(dir, '20261024220000_image.ts'), `import sharp from 'sharp';export default {execution:'maintenance',async plan(){return {summary:'native'}},async apply(){},async verify(){const bytes=await sharp({create:{width:3,height:2,channels:3,background:'#ff0000'}}).avif().toBuffer();return (await sharp(bytes).metadata()).width===3}}`)
    const manifest = await build_migration_scripts(dir, resolve(root, 'migration-scripts'))
    await package_native_runtime(root)
    const [file] = read_migrations(dir, manifest)
    const script = await load_script(file!)
    expect(await script.verify({} as never)).toBe(true)
    const evaluated = await run(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(pathToFileURL(file!.artifact!).href)});console.log(await m.default.verify())`], { cwd: root, env: { ... process.env, NODE_ENV: 'production' } })
    expect(evaluated.stdout.trim()).toBe('true')
    const inventory = JSON.parse(await readFile(resolve(root, 'native-manifest.json'), 'utf8'))
    const member = Object.keys(inventory.files).find(path => path.startsWith('node_modules/sharp/') && /\.(?:mjs|cjs|js)$/.test(path))
    expect(member).toBeTruthy()
    const dependency = resolve(root, member!)
    const original = await readFile(dependency)
    try {
      await writeFile(dependency, Buffer.concat([original, Buffer.from('\n// changed')]))
      await expect(load_script(file!)).rejects.toThrow('运行时文件校验失败')
    }
    finally { await writeFile(dependency, original) }
  }, 60_000)
  it('脚本迁移产物可脱离源码与 node_modules 加载', async () => {
    const { writeFile } = await import('node:fs/promises')
    const migration_dir = resolve(work_dir, 'migrations')
    await mkdir(migration_dir, { recursive: true })
    const contract = resolve(project_root, 'scripts/migration/contract.ts').replaceAll('\\', '/')
    await writeFile(resolve(migration_dir, '20261024030000_bundle.ts'), `import {define_migration} from ${JSON.stringify(contract)}; export default define_migration({async plan(){return {summary:'bundle'}},async apply(){},async verify(){return true}})`)
    const manifest = await build_migration_scripts(migration_dir, resolve(work_dir, 'migration-scripts'))
    const [file] = read_migrations(migration_dir, manifest)
    const script = await load_script(file!)
    expect(script.execution).toBe('maintenance')
    const source = await readFile(file!.artifact!, 'utf8')
    expect(source).not.toContain(project_root)
    const evaluated = await run(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(pathToFileURL(file!.artifact!).href)});console.log(m.default.execution)`], { cwd: work_dir })
    expect(evaluated.stdout.trim()).toBe('maintenance')
  })
  it('脱离工作区（无 node_modules）也能加载并走到建连', async () => {
    const env = { ... process.env, ... bundle_env }

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

  it('旧业务迁移命令全部并入版本链', async () => {
    const scripts = JSON.parse(await readFile(resolve(project_root, 'package.json'), 'utf8')).scripts
    expect(scripts['content:private:migrate']).toBeUndefined()
    expect(scripts['content:storage:migrate']).toBeUndefined()
    expect(scripts['content:refs:migrate']).toBeUndefined()
    const manifest = JSON.parse(await readFile(resolve(project_root, '.output/server/maintenance/migration-scripts/manifest.json'), 'utf8'))
    expect(manifest.scripts.map((item: { filename: string }) => item.filename)).toEqual(['20261024210100_content_references.ts', '20261024210200_content_workspace.ts'])
  })

  it('迁移产物同样能在容器里跑起来（只读 --status，不写库）', async () => {
    const env = { NODE_ENV: 'production', MYSQL_HOST: '127.0.0.1', MYSQL_PORT: '1', MYSQL_PASSWORD: 'placeholder', MYSQL_USER: 'stupig_tv', MYSQL_DATABASE: 'stupig_tv' }
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
