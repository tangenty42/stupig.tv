import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'dotenv'

// Include the credential names used by the production templates and common
// future secret names, without masking ordinary flags and ports.
const sensitive_key = /(?:^|_)(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|KEY)(?:_|$)/i

export function mask_commands(source: string) {
  const values = new Set(Object.entries(parse(source))
    .filter(([key, value]) => sensitive_key.test(key) && value.length > 0)
    .map(([, value]) => value))
  return [... values].map(value => `::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    for (const command of mask_commands(readFileSync('.env.prod', 'utf8')))
      process.stdout.write(`${command}\n`)
  }
  catch {
    process.stderr.write('Could not register production log masks\n')
    process.exitCode = 1
  }
}
