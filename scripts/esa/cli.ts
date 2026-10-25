import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { create_api } from './api'
import { commit_source, create_commit_description } from './commit'
import { load_publish_config, publish_plan, PublishError, require_publish_credentials } from './config'
import { preflight, publish, variable_status } from './deploy'

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('pnpm esa:deploy:dev / pnpm esa:deploy:prod [--plan | --check]\n--plan: local configuration only\n--check: read-only cloud preflight\nNo flag: sync variables, commit, deploy and verify the exact new version')
    return
  }
  if (args.length > 1 || args.some(arg => ! ['--plan', '--check'].includes(arg)))
    throw new PublishError('Usage: pnpm esa:deploy:dev / pnpm esa:deploy:prod [--plan | --check]; function targets come only from YAML')
  const config = load_publish_config()
  const source = await readFile(config.entry)
  const sha256 = createHash('sha256').update(source).digest('hex')
  const plan = { ... publish_plan(config), sha256 }
  console.log(JSON.stringify(plan, null, 2))
  if (args.includes('--plan'))
    return
  require_publish_credentials(config)
  const api = create_api(config)
  if (args.includes('--check')) {
    const result = await preflight(config, api)
    console.log(JSON.stringify({ check: 'passed', previousVersions: result.previousVersions, variables: variable_status(config, result.variables) }, null, 2))
    return
  }
  const directory = resolve('.data/esa-deploy')
  await mkdir(directory, { recursive: true })
  const lock_path = resolve(directory, `${config.name}-${config.environment}.lock`)
  const lock = await open(lock_path, 'wx').catch(() => {
    throw new PublishError('Another local ESA publish owns the target lock; inspect .data/esa-deploy before retrying')
  })
  const run = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  const receipt_path = resolve(directory, `${config.appEnvironment}-${run}.json`)
  let receipt: Record<string, unknown> = { ... plan, run, stage: 'starting', startedAt: new Date().toISOString() }
  const checkpoint = async (update: Record<string, unknown>) => {
    receipt = { ... receipt, ... update, updatedAt: new Date().toISOString() }
    await writeFile(receipt_path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    if (update.stage)
      console.log(`[ESA] ${String(update.stage)}`)
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, run }))
    await checkpoint({})
    const description = create_commit_description(config.appEnvironment, run)
    const version = await publish(config, source, description, { api, commit: commit_source, sleep: setTimeout, now: Date.now, checkpoint })
    console.log(`ESA ${config.appEnvironment}/${config.name}/${config.environment}: version ${version} deployed at 100%`)
    console.log(`Receipt: ${receipt_path}`)
    console.log('Control-plane verification passed; authorized downloads still require application smoke testing.')
  }
  catch (error) {
    await checkpoint({ failed: true })
    console.error(`Publish stopped at ${String(receipt.stage)}. Receipt: ${receipt_path}`)
    throw error
  }
  finally {
    await lock.close()
    await unlink(lock_path)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof PublishError ? error.message : 'ESA command failed; check configuration, source files and local permissions (raw diagnostics suppressed)')
  process.exitCode = 1
})
