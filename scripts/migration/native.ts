import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import { sharp_package } from './catalog'

const own_require = createRequire(import.meta.url)
export function sharp_identity() {
  const path = sharp_package(own_require)
  return { path, root: dirname(path) }
}
export async function sharp_tag() {
  const bytes = await readFile(sharp_identity().path)
  return createHash('sha256').update(bytes).digest('hex')
}

/** Ship the already-installed native closure; no package manager/network at runtime. */
export async function package_native_runtime(output: string) {
  const pending = [{ name: 'sharp', root: sharp_identity().root }]
  const copied = new Map<string, string>()
  const files: Record<string, string> = {}
  for (let index = 0; index < pending.length; index ++) {
    const item = pending[index]!
    const pkg = JSON.parse(await readFile(resolve(item.root, 'package.json'), 'utf8'))
    if (copied.has(item.name)) {
      if (copied.get(item.name) !== pkg.version)
        throw new Error('Native dependency version conflict')
      continue
    }
    copied.set(item.name, pkg.version)
    const destination = resolve(output, 'node_modules', item.name)
    await mkdir(dirname(destination), { recursive: true })
    await cp(item.root, destination, { recursive: true, dereference: true, filter: source => ! relative(item.root, source).split(sep).includes('node_modules') })
    const request = createRequire(resolve(item.root, 'package.json'))
    for (const name of Object.keys({ ... pkg.dependencies, ... pkg.optionalDependencies })) {
      try {
        let path: string
        try {
          path = request.resolve(`${name}/package.json`)
        }
        catch {
          // Native packages often export only their binary, not package.json or ".".
          const candidates = request.resolve.paths(name) ?? []
          const direct = (await Promise.all(candidates.map(async (parent) => {
            const path = resolve(parent, name, 'package.json')
            return await readFile(path, 'utf8').then(value => JSON.parse(value).name === name ? path : null, () => null)
          }))).find(Boolean)
          if (direct) {
            pending.push({ name, root: dirname(direct) })
            continue
          }
          let parent = dirname(request.resolve(name))
          while (JSON.parse(await readFile(resolve(parent, 'package.json'), 'utf8').catch(() => '{}')).name !== name) {
            const next = dirname(parent)
            if (next === parent)
              throw new Error('Native package root missing')
            parent = next
          }
          path = resolve(parent, 'package.json')
        }
        pending.push({ name, root: dirname(path) })
      }
      catch (error) {
        if (! pkg.optionalDependencies?.[name])
          throw error
      }
    }
  }
  async function inventory(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory())
        await inventory(path)
      else files[relative(output, path).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(path)).digest('hex')
    }
  }
  await inventory(resolve(output, 'node_modules'))
  await writeFile(resolve(output, 'native-manifest.json'), `${JSON.stringify({ sharp: await sharp_tag(), files }, null, 2)}\n`)
}
