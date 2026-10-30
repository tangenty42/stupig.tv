import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { build, version } from 'esbuild'
import { migration_script_names, sha256 } from './catalog'
import { package_native_runtime, sharp_tag } from './native'

const project_root = resolve(import.meta.dirname, '../..')

async function write_complete(path: string, data: string | Uint8Array) {
  const bytes = Buffer.from(data)
  if (await readFile(path).then(existing => existing.equals(bytes), () => false))
    return
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes)
  try {
    for (let attempt = 0; ; attempt ++) {
      try {
        await rename(temporary, path)
        return
      }
      catch (error) {
        // Windows may briefly deny replacement while a concurrent planner reads.
        if (await readFile(path).then(existing => existing.equals(bytes), () => false))
          return
        if (attempt >= 20 || ! ['EPERM', 'EACCES', 'EEXIST', 'EBUSY'].includes(String((error as NodeJS.ErrnoException).code)))
          throw error
        await delay(20)
      }
    }
  }
  finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        throw error
    })
  }
}
export const maintenance_build_options = {
  bundle: true,
  platform: 'node' as const,
  format: 'esm' as const,
  target: 'node24',
  alias: { '@config': resolve(project_root, 'config/lib'), '@shared': resolve(project_root, 'server/shared'), '@server': resolve(project_root, 'server') },
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  external: ['proxy-agent', 'sharp'],
}

/** Bundle each script with its dependency closure; artifact bytes are the durable identity. */
export async function build_migration_scripts(dir: string, output_dir: string) {
  await mkdir(output_dir, { recursive: true })
  const names = migration_script_names(await readdir(dir))
  const scripts = []
  for (const filename of names) {
    // stdin + a fixed sourcefile make byte identity independent of checkout/output paths.
    const source = await readFile(resolve(dir, filename), 'utf8')
    const result = await build({
      ... maintenance_build_options,
      // Applied scripts retain their original configuration and reference parsers.
      // Load snapshots under the original module identities to preserve artifact bytes.
      plugins: ['20261024210100_content_references.ts', '20261024210200_content_workspace.ts'].includes(filename)
        ? [{
            name: 'content-v1-frozen-config',
            setup(plugin) {
              plugin.onLoad({ filter: /[\\/]server[\\/]services[\\/]content[\\/]sync-outbox\.repository\.ts$/ }, async () => ({
                contents: await readFile(resolve(project_root, 'migrations/lib/content-v1/sync-outbox.repository.ts.snapshot'), 'utf8'),
                loader: 'ts',
                resolveDir: resolve(project_root, 'server/services/content'),
              }))
              plugin.onLoad({ filter: /[\\/]server[\\/]shared[\\/]types[\\/]sync\.ts$/ }, async () => ({
                contents: await readFile(resolve(project_root, 'migrations/lib/content-v1/sync-types.ts.snapshot'), 'utf8'),
                loader: 'ts',
                resolveDir: resolve(project_root, 'server/shared/types'),
              }))
              plugin.onLoad({ filter: /[\\/]server[\\/]lib[\\/]sync-channel\.ts$/ }, async () => ({
                contents: await readFile(resolve(project_root, 'migrations/lib/content-v1/sync-channel.ts.snapshot'), 'utf8'),
                loader: 'ts',
                resolveDir: resolve(project_root, 'server/lib'),
              }))
              plugin.onLoad({ filter: /[\\/]server[\\/]shared[\\/]content-workspace\.ts$/ }, async () => ({
                contents: await readFile(resolve(project_root, 'migrations/lib/content-v1/content-workspace.ts.snapshot'), 'utf8'),
                loader: 'ts',
                resolveDir: resolve(project_root, 'server/shared'),
              }))
              plugin.onLoad({ filter: /[\\/]server[\\/]shared[\\/]content-(?:markdown|reference)\.ts$/ }, async ({ path }) => ({
                contents: await readFile(resolve(project_root, `migrations/lib/content-v1/${path.endsWith('content-markdown.ts') ? 'content-markdown' : 'content-reference'}.ts.snapshot`), 'utf8'),
                loader: 'ts',
                resolveDir: resolve(project_root, 'server/shared'),
              }))
              plugin.onLoad({ filter: /[\\/]config[\\/]lib[\\/]loader\.ts$/ }, async () => ({
                contents: await readFile(resolve(project_root, 'migrations/lib/content-v1/config-loader.ts.snapshot'), 'utf8'),
                loader: 'ts',
                resolveDir: resolve(project_root, 'config/lib'),
              }))
              plugin.onLoad({ filter: /[\\/]config[\\/]lib[\\/]schema\.ts$/ }, async () => ({
                contents: await readFile(resolve(project_root, 'migrations/lib/content-v1/config-schema.ts.snapshot'), 'utf8'),
                loader: 'ts',
                resolveDir: resolve(project_root, 'config/lib'),
              }))
              plugin.onLoad({ filter: /[\\/]server[\\/]shared[\\/]settings\.generated\.ts$/ }, async () => ({
                contents: await readFile(resolve(project_root, 'migrations/lib/content-v1/settings.generated.ts.snapshot'), 'utf8'),
                loader: 'ts',
                resolveDir: resolve(project_root, 'server/shared'),
              }))
            },
          }]
        : [],
      absWorkingDir: project_root,
      stdin: { contents: source, resolveDir: dir, sourcefile: `migrations/${filename}`, loader: 'ts' },
      write: false,
      metafile: true,
      legalComments: 'none',
      minify: true,
    })
    for (const item of Object.values(result.metafile!.outputs).flatMap(item => item.imports)) {
      if (item.external && ! item.path.startsWith('node:') && ! builtinModules.includes(item.path) && ! ['proxy-agent', 'sharp'].includes(item.path))
        throw new Error(`迁移脚本仍依赖未打包模块：${filename}`)
    }
    const needs_sharp = Object.values(result.metafile!.outputs).some(item => item.imports.some(imported => imported.path === 'sharp'))
    const bytes = needs_sharp ? Buffer.concat([Buffer.from(`// migration-native-sharp:${await sharp_tag()}\n`), result.outputFiles[0]!.contents]) : result.outputFiles[0]!.contents
    const checksum = sha256(Buffer.from(bytes))
    const artifact = `${filename.slice(0, - 3)}-${checksum}.mjs`
    await write_complete(resolve(output_dir, artifact), bytes)
    scripts.push({ filename, checksum, source_checksum: sha256(source), artifact })
  }
  const manifest = resolve(output_dir, 'manifest.json')
  await write_complete(manifest, `${JSON.stringify({ version: 1, compiler: `esbuild@${version}`, scripts }, null, 2)}\n`)
  return manifest
}

export async function build_maintenance() {
  const output = resolve(project_root, '.output/server/maintenance')
  const entries = {
    'cleanup.mjs': 'storage/audit.ts',
    'migrate.mjs': 'migration/cli.ts',
  }
  for (const [name, source] of Object.entries(entries)) {
    const outfile = resolve(output, name)
    await mkdir(dirname(outfile), { recursive: true })
    await build({ ... maintenance_build_options, entryPoints: [resolve(project_root, 'scripts', source)], outfile })
  }
  await build_migration_scripts(resolve(project_root, 'migrations'), resolve(output, 'migration-scripts'))
  await package_native_runtime(output)
}
