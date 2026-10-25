import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'dotenv'

const environment_files = { development: '.env.dev', production: '.env.prod' }

export function environment_file(node_env) {
  if (! Object.hasOwn(environment_files, node_env))
    throw new Error('Invalid NODE_ENV: expected development or production')
  return environment_files[node_env]
}

/** File values are local defaults; injected process variables keep precedence. */
export function load_environment({ env = process.env, cwd = process.cwd(), node_env = env.NODE_ENV } = {}) {
  const filename = environment_file(node_env)
  const path = resolve(cwd, filename)
  const parsed = existsSync(path) ? parse(readFileSync(path, 'utf8')) : {}
  if (parsed.NODE_ENV !== undefined && parsed.NODE_ENV !== node_env)
    throw new Error(`NODE_ENV in ${filename} must be ${node_env}`)
  const injected = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined))
  return { ... parsed, ... injected, NODE_ENV: node_env }
}

/** --env selects the application environment; ESA's --environment is unrelated. */
export function prepare_cli_environment(argv, env = process.env, cwd = process.cwd()) {
  const args = []
  let selected
  for (let index = 0; index < argv.length; index ++) {
    const arg = argv[index]
    if (arg === '--env' || arg.startsWith('--env=')) {
      if (selected !== undefined)
        throw new Error('Specify --env only once')
      const value = arg === '--env' ? argv[++ index] : arg.slice('--env='.length)
      const aliases = { dev: 'development', prod: 'production', development: 'development', production: 'production' }
      selected = Object.hasOwn(aliases, value) ? aliases[value] : undefined
      if (! selected)
        throw new Error('Invalid --env: expected dev or prod')
    }
    else {
      args.push(arg)
    }
  }
  const node_env = selected ?? env.NODE_ENV ?? 'development'
  return { args, node_env, filename: environment_file(node_env), env: load_environment({ env, cwd, node_env }) }
}

export function initialize_cli_environment() {
  const selected = prepare_cli_environment(process.argv.slice(2))
  Object.assign(process.env, selected.env)
  process.argv.splice(2, process.argv.length - 2, ... selected.args)
  return selected
}
