import type { Connection, RowDataPacket } from 'mysql2/promise'
import type { LegacyFolderImage } from './legacy-folder-images'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { initialize_cli_environment } from '@config/environment.mjs'
import { load_database_config } from '@config/loader'
import { attachment_mime_type } from '@shared/content-markdown'
import mysql from 'mysql2/promise'
import { scan_legacy_folder_images } from './legacy-folder-images'

type InventoryEnvironment = 'development' | 'production'
interface PublishedRow { id: string | number, markdown: string }
interface DraftRow { id: string, story_id: string | number | null, markdown: string }
interface AttachmentRow { story_id: string | number, parent_id: string | number | null, file_name: string, is_folder: number | boolean, mime_type: string | null }
interface InventoryDocument { kind: 'published' | 'draft', id: string, story_id: string | null }
interface InventoryFinding { document: InventoryDocument, reference: LegacyFolderImage }
interface InventoryData { published: PublishedRow[], drafts: DraftRow[], attachments: AttachmentRow[] }

class InventoryValidationError extends Error {}

export class InventoryScanError extends Error {
  constructor(readonly document: InventoryDocument) {
    super('document_scan_failed')
  }
}

export function inventory_arguments(argv: readonly string[]) {
  let environment: InventoryEnvironment | undefined
  let expected_local_port: number | undefined
  for (let index = 0; index < argv.length; index ++) {
    const argument = argv[index]!
    if (argument === '--env' || argument.startsWith('--env=')) {
      if (environment)
        throw new InventoryValidationError('duplicate_environment')
      const value = argument === '--env' ? argv[++ index] : argument.slice('--env='.length)
      if (value === 'dev' || value === 'development')
        environment = 'development'
      else if (value === 'prod' || value === 'production')
        environment = 'production'
      else
        throw new InventoryValidationError('invalid_environment')
    }
    else if (argument.startsWith('--expect-local-port=')) {
      const value = Number(argument.slice('--expect-local-port='.length))
      if (expected_local_port !== undefined || ! Number.isInteger(value) || value < 1 || value > 65535)
        throw new InventoryValidationError('invalid_expected_port')
      expected_local_port = value
    }
    else {
      throw new InventoryValidationError('unknown_inventory_argument')
    }
  }
  if (! environment)
    throw new InventoryValidationError('explicit_environment_required')
  return { environment, expected_local_port }
}

/** An optional check pins this run to a previously verified local endpoint. */
export function assert_inventory_endpoint(database: { host: string, port: number }, expected_local_port?: number) {
  if (expected_local_port !== undefined && (! ['127.0.0.1', 'localhost', '::1'].includes(database.host) || database.port !== expected_local_port))
    throw new InventoryValidationError('inventory_endpoint_mismatch')
}

export async function read_inventory(connection: Pick<Connection, 'query' | 'execute' | 'rollback'>) {
  await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await connection.query('SET SESSION TRANSACTION READ ONLY')
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT')
  try {
    const [[identity]] = await connection.query<RowDataPacket[]>('SELECT DATABASE() AS database_name, UTC_TIMESTAMP(6) AS read_at')
    if (! identity)
      throw new InventoryValidationError('inventory_identity_missing')
    const [published] = await connection.execute<(RowDataPacket & PublishedRow)[]>('SELECT id, markdown FROM content_stories ORDER BY id')
    const [drafts] = await connection.execute<(RowDataPacket & DraftRow)[]>('SELECT id, story_id, markdown FROM content_story_drafts ORDER BY id')
    const [attachments] = await connection.execute<(RowDataPacket & AttachmentRow)[]>('SELECT story_id, parent_id, file_name, is_folder, mime_type FROM content_story_attachments ORDER BY story_id, id')
    return { database: String(identity.database_name), read_at: String(identity.read_at), published, drafts, attachments }
  }
  finally {
    await connection.rollback()
  }
}

export function build_inventory(data: InventoryData, scanner = scan_legacy_folder_images) {
  const catalogs = new Map<string, { files: { file_name: string, is_image: boolean }[], folders: string[] }>()
  for (const row of data.attachments) {
    if (! row.file_name)
      continue
    const scope = String(row.story_id)
    let catalog = catalogs.get(scope)
    if (! catalog) {
      catalog = { files: [], folders: [] }
      catalogs.set(scope, catalog)
    }
    if (row.is_folder)
      catalog.folders.push(row.file_name)
    else
      catalog.files.push({ file_name: row.file_name, is_image: (row.mime_type ?? attachment_mime_type(row.file_name) ?? '').startsWith('image/') })
  }
  const documents = [
    ... data.published.map(row => ({ kind: 'published' as const, id: String(row.id), story_id: String(row.id), markdown: row.markdown })),
    ... data.drafts.map(row => ({ kind: 'draft' as const, id: row.id, story_id: row.story_id === null ? null : String(row.story_id), markdown: row.markdown })),
  ]
  const findings: InventoryFinding[] = []
  for (const { markdown, ... document } of documents) {
    const catalog = document.story_id === null ? undefined : catalogs.get(document.story_id)
    try {
      for (const reference of scanner(markdown, catalog?.files ?? [], catalog?.folders ?? []))
        findings.push({ document, reference })
    }
    catch {
      // A malformed document must never be counted as a successful empty scan.
      throw new InventoryScanError(document)
    }
  }
  return { published: data.published.length, drafts: data.drafts.length, findings }
}

function literal_block(value: string) {
  const longest = Math.max(0, ... Array.from(value.matchAll(/`+/g), match => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}markdown\n${value}\n${fence}`
}

export function inventory_report(environment: InventoryEnvironment, database: string, read_at: string, result: ReturnType<typeof build_inventory>) {
  const counts = Object.fromEntries(['images', 'folder-card', 'missing'].map(kind => [kind, result.findings.filter(item => item.reference.kind === kind).length]))
  const lines = [
    '# 旧文件夹图片引用清点',
    '',
    `环境：${environment}；数据库：${database}；读取时刻（UTC）：${read_at}`,
    '',
    `完整扫描正式版 ${result.published} 份、云端草稿 ${result.drafts} 份。命中 ${result.findings.length} 处：图片展开 ${counts.images}、无直属图片目录转卡片 ${counts['folder-card']}、目标失效待人工核对 ${counts.missing}。`,
    '',
    '仅为本次只读快照的迁移建议，没有修改数据库。开发库结果不代表生产库。每处只列引用片段，没有收录整篇正文；未查询或生成签名地址。',
  ]
  for (const { document, reference } of result.findings) {
    lines.push('', `## ${document.kind === 'published' ? '正式版' : '云端草稿'} ${document.id}：第 ${reference.line} 行`, '',
      `所属档案：${document.story_id ?? '未绑定'}；源码 UTF-16 范围：${reference.from}–${reference.to}；类别：${reference.kind}`, '',
      '原引用：', '', literal_block(reference.source), '',
      reference.replacement === null ? '目标失效，无法确认原本引用的是文件还是文件夹；请人工核对，不自动替换。' : `建议替换：\n\n${literal_block(reference.replacement)}`)
  }
  return `${lines.join('\n')}\n`
}

async function main() {
  const options = inventory_arguments(process.argv.slice(2))
  const selected = initialize_cli_environment()
  if (selected.node_env !== options.environment)
    throw new InventoryValidationError('inventory_environment_mismatch')
  const database = load_database_config()
  assert_inventory_endpoint(database, options.expected_local_port)
  const connection = await mysql.createConnection({
    host: database.host, port: database.port, user: database.user, password: database.password, database: database.name,
    timezone: 'Z', dateStrings: true, connectTimeout: 10000, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true,
  })
  try {
    const data = await read_inventory(connection)
    if (data.database !== database.name)
      throw new InventoryValidationError('inventory_database_mismatch')
    const result = build_inventory(data)
    const directory = resolve('.dev/legacy-folder-images')
    const report = resolve(directory, `${options.environment}.md`)
    await mkdir(directory, { recursive: true })
    await writeFile(report, inventory_report(options.environment, data.database, data.read_at, result), 'utf8')
    console.log(JSON.stringify({ environment: options.environment, database: data.database, report, published: result.published, drafts: result.drafts,
      findings: Object.fromEntries(['images', 'folder-card', 'missing'].map(kind => [kind, result.findings.filter(item => item.reference.kind === kind).length])) }))
  }
  finally {
    await connection.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // Driver/parser errors may include source text or connection details.
    console.error(JSON.stringify(error instanceof InventoryScanError
      ? { error: error.message, document: error.document }
      : error instanceof InventoryValidationError
        ? { error: error.message }
        : { error: 'inventory_failed', code: (error as NodeJS.ErrnoException).code ?? 'inventory_error' }))
    process.exitCode = 1
  })
}
