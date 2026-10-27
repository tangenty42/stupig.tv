/**
 * Playwright 分片既作为独立 CI job 并行，也可能在本机同时运行，因此每个分片
 * 独占一个端口。未分片时保持文档中的 3142；启动器与 `playwright.config.ts`
 * 由同一处规则推导，浏览器目标与被构建服务器的端口不可能对不上。
 */
const BASE_PORT = 3142
// 分片端口落在 3142–3161；再大的分片数需要先调整基准端口。
const MAX_SHARDS = 20

export interface E2eTarget {
  port: number
  baseUrl: string
  shard: { current: number, total: number }
}

/** 同时接受 `--shard=i/n` 与 `--shard i/n` 两种写法。 */
function parse_shard(argv: readonly string[]) {
  const attached = argv.find(argument => argument.startsWith('--shard='))
  const separate = argv.indexOf('--shard')
  const raw = attached?.slice('--shard='.length) ?? (separate < 0 ? undefined : argv[separate + 1])
  if (raw === undefined)
    return { current: 1, total: 1 }
  const match = /^([1-9]\d{0,2})\/([1-9]\d{0,2})$/.exec(raw)
  if (! match || Number(match[1]) > Number(match[2]) || Number(match[2]) > MAX_SHARDS)
    throw new Error(`Invalid Playwright --shard value: ${raw}; expected i/n with n <= ${MAX_SHARDS}`)
  return { current: Number(match[1]), total: Number(match[2]) }
}

export function e2e_target(argv: readonly string[]): E2eTarget {
  const shard = parse_shard(argv)
  const port = BASE_PORT + shard.current - 1
  return { port, baseUrl: `http://localhost:${port}`, shard }
}
