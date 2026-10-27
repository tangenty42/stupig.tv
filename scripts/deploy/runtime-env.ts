import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'dotenv'
import { collect_assignments } from '../env/build'

const publisher_prefix = 'ALIYUN_ESA_PUBLISH_'

/** Preserve application settings verbatim while keeping publisher credentials on the runner. */
export function runtime_environment(source: string) {
  const lines = source.split(/\r?\n/)
  const assignments = collect_assignments(source, 'production environment')
  const removed = new Set<number>()
  for (const assignment of assignments) {
    if (assignment.key.startsWith(publisher_prefix)) {
      for (let index = assignment.start_line; index <= assignment.end_line; index ++)
        removed.add(index)
    }
  }
  const result = lines.filter((_, index) => ! removed.has(index)).join(source.includes('\r\n') ? '\r\n' : '\n')
  const original = parse(source)
  const runtime = parse(result)
  for (const [key, value] of Object.entries(original)) {
    if (key.startsWith(publisher_prefix) ? Object.hasOwn(runtime, key) : runtime[key] !== value)
      throw new Error('Cannot safely separate the production environment')
  }
  for (const [key, value] of Object.entries(runtime)) {
    if (key.startsWith(publisher_prefix) || original[key] !== value)
      throw new Error('Cannot safely separate the production environment')
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const output = resolve('.env.prod.runtime')
    const runtime = runtime_environment(readFileSync('.env.prod', 'utf8'))
    writeFileSync(output, runtime, { mode: 0o600 })
    chmodSync(output, 0o600)
  }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Cannot prepare runtime environment'}\n`)
    process.exitCode = 1
  }
}
