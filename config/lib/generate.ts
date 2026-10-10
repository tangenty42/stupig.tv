import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { load_settings } from './loader'

export async function generate_settings(check = false) {
  const file_path = resolve('server/shared/settings.generated.ts')
  const source = `import type { Settings } from '../../config/lib/schema'\n\nexport const settings: Settings = ${JSON.stringify(load_settings(), null, 2)}\n`
  const eslint = new ESLint({ fix: true })
  const [result] = await eslint.lintText(source, { filePath: file_path })
  if (! result) {
    throw new Error('Cannot generate settings: ESLint returned no result')
  }
  if (result.errorCount) {
    throw new Error(`Cannot generate settings: ${result.messages.map(message => message.message).join('; ')}`)
  }
  const output = result.output ?? source
  if (existsSync(file_path) && readFileSync(file_path, 'utf8') === output) {
    return false
  }
  if (check) {
    throw new Error('Generated settings are stale; run pnpm settings:generate')
  }
  writeFileSync(file_path, output)
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generate_settings(process.argv.includes('--check')).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
