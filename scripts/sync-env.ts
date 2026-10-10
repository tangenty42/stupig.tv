import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { parse as parse_dotenv } from 'dotenv'

interface SyncEnvResult {
  created: boolean
  added: string[]
  unknown: string[]
  overridden: string[]
  required: string[]
}

interface EnvAssignment {
  key: string
  start_line: number
  end_line: number
  prefix: string
  value: string
}

const environment_names = ['dev', 'prod'] as const
type EnvironmentName = (typeof environment_names)[number]
type TemplateTag = 'shared' | EnvironmentName
// NODE_ENV uses the long names; the templates and CLI flags use the short ones.
const environment_aliases: Record<string, EnvironmentName> = { development: 'dev', production: 'prod' }
const local_only_header = '# Local-only keys preserved by pnpm env:build'
// Older syncs used the env:sync name; treat that header as a section marker too.
const local_only_header_pattern = /^# Local-only keys preserved by pnpm env:(?:sync|build)$/

export function environment_from_argv(argv: string[], node_env = process.env.NODE_ENV): EnvironmentName {
  const flag = argv.find(arg => arg.startsWith('--'))
  const environment = flag?.slice(2) ?? node_env
  if (environment === undefined) {
    throw new Error('NODE_ENV is not set; run pnpm env:build:dev or pnpm env:build:prod explicitly')
  }
  const normalized = environment in environment_aliases ? environment_aliases[environment] : environment
  if (! (environment_names as readonly string[]).includes(normalized)) {
    throw new Error(`Unknown environment "${environment}"; expected --dev or --prod`)
  }
  return normalized as EnvironmentName
}

function all_template_paths() {
  return [
    resolve(process.cwd(), '.env.shared.layer'),
    resolve(process.cwd(), '.env.dev.layer'),
    resolve(process.cwd(), '.env.prod.layer'),
  ]
}

function selected_template_files(template_paths: string[], environment: EnvironmentName) {
  const files = template_paths.map(path => ({ tag: template_tag_from_path(path), source: readFileSync(path, 'utf8') }))
  return files.filter(file => file.tag === 'shared' || file.tag === environment)
}

function all_template_files(template_paths: string[]) {
  return template_paths.map(path => ({ tag: template_tag_from_path(path), source: readFileSync(path, 'utf8') }))
}

function selected_files(files: { tag: TemplateTag, source: string }[], environment: EnvironmentName) {
  return files
    .filter(file => file.tag === 'shared' || file.tag === environment)
}

function template_tag_from_path(path: string): TemplateTag {
  const name = path.split(/[\\/]/).pop() ?? ''
  const tag = name.match(/^\.env\.([a-z]+)\.layer$/)?.[1]
  if (tag === 'shared' || (environment_names as readonly string[]).includes(tag ?? '')) {
    return tag as TemplateTag
  }
  throw new Error(`Unrecognized env template name: ${name}`)
}

function collect_assignments(source: string, source_name: string): EnvAssignment[] {
  const lines = source.split(/\r?\n/)
  const assignments: EnvAssignment[] = []
  const keys = new Set<string>()

  for (let index = 0; index < lines.length; index ++) {
    const match = lines[index].match(/^(\s*(?:export\s+)?)([\w.-]+)(\s*(?:=\s*|:\s+))/)
    if (! match) {
      continue
    }

    const [, indentation, key, separator] = match
    const first_value_line = lines[index].slice(match[0].length)
    if (keys.has(key)) {
      throw new Error(`Duplicate environment key ${key} in ${source_name}`)
    }
    keys.add(key)

    let end_line = index
    const quote = first_value_line.trimStart().match(/^(['"`])/)?.[1]
    if (quote) {
      // The value starts right after the matched "KEY=" prefix.
      const prefix_length = match[0].length
      let escaped = false
      let closing_quote_found = false
      for (let line_index = index; line_index < lines.length && ! closing_quote_found; line_index ++) {
        const line = lines[line_index]
        escaped = false
        const start: number = line_index === index ? line.indexOf(quote, prefix_length) + 1 : 0
        for (let column = start; column < line.length; column ++) {
          const character = line[column]
          if (character === quote && ! escaped) {
            end_line = line_index
            closing_quote_found = true
            break
          }
          if (character === '\\') {
            escaped = ! escaped
          }
          else {
            escaped = false
          }
        }
      }
      if (! closing_quote_found) {
        throw new Error(`Unterminated quoted value for ${key} in ${source_name}`)
      }
    }

    assignments.push({
      key,
      start_line: index,
      end_line,
      prefix: `${indentation}${key}${separator}`,
      value: [first_value_line, ... lines.slice(index + 1, end_line + 1)].join('\n'),
    })
    index = end_line
  }

  return assignments
}

function collect_local_blocks(lines: string[], assignments: EnvAssignment[], keys: Set<string>) {
  const blocks = new Map<string, string[]>()
  for (const assignment of assignments) {
    if (! keys.has(assignment.key)) {
      continue
    }

    let block_start = assignment.start_line
    while (
      block_start > 0
      && block_start - 1 >= 0
      && /^\s*#/.test(lines[block_start - 1])
      && ! local_only_header_pattern.test(lines[block_start - 1])
    ) {
      block_start --
    }
    const block = lines.slice(block_start, assignment.end_line + 1)
    blocks.set(block.join('\n'), block)
  }
  return [... blocks.values()].flat()
}

function collect_template_keys(files: { tag: TemplateTag, source: string }[]) {
  const key_tags = new Map<string, Map<TemplateTag, string>>()
  for (const file of files) {
    for (const assignment of collect_assignments(file.source, `.env.${file.tag}.layer`)) {
      const tags = key_tags.get(assignment.key) ?? new Map<TemplateTag, string>()
      tags.set(file.tag, assignment.value)
      key_tags.set(assignment.key, tags)
    }
  }
  return key_tags
}

// The default for a missing key: the synced environment's template wins, then shared.
function default_template_value(tags: Map<TemplateTag, string>, first_value: string, environment: EnvironmentName) {
  return tags.get(environment) ?? tags.get('shared') ?? first_value
}

export function missing_required_keys(template_paths: string[], env_path = resolve(process.cwd(), '.env'), environment: EnvironmentName = 'dev'): string[] {
  const files = selected_template_files(template_paths, environment)
  const key_tags = collect_template_keys(files)
  const env_values = existsSync(env_path) ? parse_dotenv(readFileSync(env_path, 'utf8')) : {}
  return [... key_tags]
    .filter(([key, tags]) => {
      // A leftover <required> value counts as missing: prompt again until it is filled.
      const missing = ! Object.hasOwn(env_values, key) || env_values[key] === '<required>'
      // Only prompt for keys the synced environment actually uses.
      return missing
        && (tags.has('shared') || tags.has(environment))
        && default_template_value(tags, '', environment) === '<required>'
    })
    .map(([key]) => key)
}

export function sync_env_files(template_paths: string[], env_path = resolve(process.cwd(), '.env'), provided_values: Record<string, string> = {}, environment: EnvironmentName = 'dev'): SyncEnvResult {
  const all_files = all_template_files(template_paths)
  const files = selected_files(all_files, environment)
  const key_tags = collect_template_keys(files)
  const all_keys = collect_template_keys(all_files)
  const template_values = new Map<string, string>()
  for (const file of files) {
    for (const [key, value] of Object.entries(parse_dotenv(file.source))) {
      template_values.set(key, value)
    }
  }
  const created = ! existsSync(env_path)

  const env_source = created ? '' : readFileSync(env_path, 'utf8')
  const env_values = parse_dotenv(env_source)
  const env_assignments = created ? [] : collect_assignments(env_source, '.env')
  const env_assignment_map = new Map(env_assignments.map(assignment => [assignment.key, assignment]))
  const unrecognized_keys = Object.keys(env_values).filter(key => ! env_assignment_map.has(key))
  if (unrecognized_keys.length) {
    throw new Error(`Cannot safely preserve environment keys: ${unrecognized_keys.join(', ')}`)
  }

  const added = [... key_tags.keys()].filter(key => ! Object.hasOwn(env_values, key))
  const unknown = Object.keys(env_values).filter(key => ! all_keys.has(key))
  const overridden = [... key_tags.keys()].filter((key) => {
    const template_value = template_values.get(key)
    return Object.hasOwn(env_values, key)
      && env_values[key] !== '<required>'
      && template_value !== undefined
      && template_value !== '<required>'
      && env_values[key] !== template_value
  })
  const required: string[] = []
  const newline = files.some(file => file.source.includes('\r\n')) ? '\r\n' : '\n'
  const seen = new Set<string>()
  const chunks: string[] = []

  for (const file of files) {
    const lines = file.source.split(/\r?\n/)
    while (lines.length && lines[lines.length - 1] === '') {
      lines.pop()
    }
    const assignments = collect_assignments(file.source, `.env.${file.tag}.layer`)
    const assignment_by_start = new Map(assignments.map(assignment => [assignment.start_line, assignment]))
    const skip = new Set<number>()

    for (const assignment of assignments) {
      if (! seen.has(assignment.key)) {
        seen.add(assignment.key)
        continue
      }
      // Repeated in a later template: keep the first occurrence's position, drop this block.
      let block_start = assignment.start_line
      while (block_start > 0 && /^\s*#/.test(lines[block_start - 1])) {
        block_start --
      }
      for (let line = block_start; line <= assignment.end_line; line ++) {
        skip.add(line)
      }
    }

    const output: string[] = []
    for (let index = 0; index < lines.length; index ++) {
      if (skip.has(index)) {
        continue
      }
      const assignment = assignment_by_start.get(index)
      if (! assignment) {
        output.push(lines[index])
        continue
      }

      const existing = env_assignment_map.get(assignment.key)
      // A leftover <required> placeholder counts as an empty value.
      const existing_value = existing && existing.value !== '<required>' ? existing.value : undefined
      const value = existing_value
        ?? provided_values[assignment.key]
        ?? default_template_value(key_tags.get(assignment.key)!, assignment.value, environment)
      if (existing_value === undefined && value === '<required>') {
        required.push(assignment.key)
      }
      output.push(`${assignment.prefix}${value}`)
      index = assignment.end_line
    }
    chunks.push(output.join(newline))
  }

  let output_text = `${chunks.filter(chunk => chunk !== '').join(`${newline}${newline}`)}${newline}`
  if (unknown.length) {
    const env_lines = env_source.split(/\r?\n/)
    const local_blocks = collect_local_blocks(env_lines, env_assignments, new Set(unknown))
    const local_section = [local_only_header, ... local_blocks].join(newline)
    output_text = `${output_text.replace(/(?:\r?\n)+$/, '')}${newline}${newline}${local_section}${newline}`
  }

  writeFileSync(env_path, output_text, created ? { encoding: 'utf8', flag: 'wx', mode: 0o600 } : 'utf8')
  return { created, added, unknown, overridden, required }
}

export function sync_summary(result: SyncEnvResult, env_path: string, environment: EnvironmentName, provided_values: Record<string, string> = {}) {
  const file_name = env_path.split(/[\\/]/).pop() ?? env_path
  const lines = [result.created
    ? `Created ${file_name} from the shared and ${environment} layers.`
    : `Synchronized ${file_name} with the ${environment} defaults.`]
  if (result.unknown.length) {
    lines.push(`Preserved local-only keys: ${result.unknown.join(', ')}`)
  }
  const defaulted = result.added.filter(key => ! provided_values[key] && ! result.required.includes(key))
  const filled = Object.keys(provided_values)
  if (defaulted.length) {
    lines.push(`Added with template defaults, review them: ${defaulted.join(', ')}`)
  }
  if (filled.length) {
    lines.push(`Filled from input: ${filled.join(', ')}`)
  }
  if (result.overridden.length) {
    lines.push(`Overrides from existing values: ${result.overridden.join(', ')}`)
  }
  if (result.required.length) {
    lines.push(`Fill these required values in ${file_name}: ${result.required.join(', ')}`)
  }
  return lines
}

async function prompt_required_values(keys: string[]) {
  const values: Record<string, string> = {}
  if (! keys.length || ! process.stdin.isTTY) {
    return values
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    process.stdout.write('Required keys missing (press Enter to skip and fill them in the target env file later):\n')
    for (const key of keys) {
      const answer = (await rl.question(`  ${key}=`)).trim()
      if (answer) {
        values[key] = answer
      }
    }
  }
  finally {
    rl.close()
  }
  return values
}

async function main() {
  const environment = environment_from_argv(process.argv.slice(2))
  const template_paths = all_template_paths()
  // 生产环境的内容维护在 gitignore 的 .env.prod（加密成 .env.prod.gpg 入库，由 CD 解密推送）
  const env_path = resolve(process.cwd(), environment === 'prod' ? '.env.prod' : '.env')
  const required_keys = missing_required_keys(template_paths, env_path, environment)
  const provided_values = await prompt_required_values(required_keys)
  const result = sync_env_files(template_paths, env_path, provided_values, environment)
  for (const line of sync_summary(result, env_path, environment, provided_values)) {
    process.stdout.write(`${line}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
