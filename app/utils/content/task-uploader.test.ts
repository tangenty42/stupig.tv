import type { ContentTaskPart, ContentTaskResumeState, ContentTaskUploadedPart } from '@shared/types/content'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { part_bytes, part_numbers, upload_task_item } from '~/utils/content/task-uploader'

const MB = 1024 * 1024

describe('part plan helpers', () => {
  it('part_numbers 按片大小切分（不足一片算一片）', () => {
    expect(part_numbers(8 * MB, 8 * MB)).toEqual([1])
    expect(part_numbers(8 * MB + 1, 8 * MB)).toEqual([1, 2])
    expect(part_numbers(20 * MB, 8 * MB)).toEqual([1, 2, 3])
  })

  it('part_bytes 末片按剩余字节收窄', () => {
    expect(part_bytes(8 * MB, 20 * MB, 3)).toBe(4 * MB)
    expect(part_bytes(8 * MB, 20 * MB, 1)).toBe(8 * MB)
  })
})

interface StubState {
  resume: ContentTaskResumeState
  sign_calls: number[][]
  puts: { url: string, size: number }[]
  progress: number[]
  completed: ContentTaskUploadedPart[][]
  put_failure_at: number | null
  put_delay: number
}

const state = vi.hoisted(() => ({
  resume: null,
  sign_calls: [],
  puts: [],
  progress: [],
  completed: [],
  put_failure_at: null,
  put_delay: 0,
}) as unknown as StubState)

function make_callbacks() {
  return {
    sign_parts: vi.fn(async (part_numbers: number[]) => {
      state.sign_calls.push([... part_numbers] as never)
      const parts: ContentTaskPart[] = part_numbers.map(part_number => ({ part_number, url: `https://signed/${part_number}` }))
      return { parts }
    }),
    report_progress: vi.fn(async (bytes_done: number) => {
      state.progress.push(bytes_done as never)
    }),
    report_completed: vi.fn(async (parts: ContentTaskUploadedPart[]) => {
      state.completed.push(parts as never)
    }),
    fetch_resume_state: vi.fn(async () => state.resume),
  }
}

/** A transport that records what it was asked to PUT and reports the bytes in one go. */
function make_transport() {
  let call = 0
  return {
    put: vi.fn(async ({ url, body, signal, on_progress }: {
      url: string
      body: Blob
      signal: AbortSignal
      on_progress: (sent: number) => void
    }) => {
      call ++
      state.puts.push({ url, size: body.size } as never)
      on_progress(body.size)
      if (state.put_delay)
        await new Promise(resolve => setTimeout(resolve, state.put_delay))
      if (signal.aborted) {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
      if (state.put_failure_at === call)
        throw new Error('网络断了')
      return { etag: `etag-${call}` }
    }),
  }
}

beforeEach(() => {
  state.resume = { staging_key: 'content-upload/42/x', upload_id: 'up-1', part_size: 8 * MB, uploaded_parts: [], sign_batch_size: 20 }
  state.sign_calls = []
  state.puts = []
  state.progress = []
  state.completed = []
  state.put_failure_at = null
  state.put_delay = 0
})

function run(size: number, overrides: Partial<Parameters<typeof upload_task_item>[0]> = {}) {
  return upload_task_item({
    file: new Blob([new Uint8Array(size)]),
    size,
    callbacks: make_callbacks(),
    transport: make_transport(),
    signal: new AbortController().signal,
    progress_step: 0,
    ... overrides,
  })
}

describe('upload_task_item：单次 PUT', () => {
  it('无 multipart 时整文件一次 PUT，并把 ETag 报回完成', async () => {
    state.resume = { staging_key: 'k', upload_id: null, part_size: null, uploaded_parts: [], sign_batch_size: 20 }

    await run(1024)

    expect(state.sign_calls).toEqual([[1]])
    expect(state.puts).toEqual([{ url: 'https://signed/1', size: 1024 }])
    expect(state.completed[0]).toEqual([{ part_number: 1, etag: 'etag-1', size: 1024 }])
  })

  it('片大小低于服务端下限也走单次 PUT（不会误判成 multipart）', async () => {
    state.resume = { staging_key: 'k', upload_id: 'up-1', part_size: 1024, uploaded_parts: [], sign_batch_size: 20 }

    await run(1024)

    expect(state.sign_calls).toEqual([[1]])
    expect(state.puts).toHaveLength(1)
  })
})

describe('upload_task_item：multipart', () => {
  it('按片切片上传，收集 ETag 并按序回报', async () => {
    await run(20 * MB)

    expect(state.sign_calls).toEqual([[1, 2, 3]])
    expect(state.puts).toEqual([
      { url: 'https://signed/1', size: 8 * MB },
      { url: 'https://signed/2', size: 8 * MB },
      { url: 'https://signed/3', size: 4 * MB },
    ])
    expect(state.completed).toHaveLength(1)
    expect(state.completed[0]!.map(part => part.part_number)).toEqual([1, 2, 3])
  })

  it('按服务端批大小分批预签', async () => {
    state.resume = { ... state.resume, sign_batch_size: 2 }

    await run(40 * MB)

    expect(state.sign_calls).toEqual([[1, 2], [3, 4], [5]])
  })

  it('并发受 concurrency 限制', async () => {
    let in_flight = 0
    let peak = 0
    const callbacks = make_callbacks()
    const transport = {
      put: vi.fn(async ({ url, body, on_progress }: { url: string, body: Blob, on_progress: (sent: number) => void }) => {
        in_flight ++
        peak = Math.max(peak, in_flight)
        await new Promise(resolve => setTimeout(resolve, 5))
        on_progress(body.size)
        in_flight --
        return { etag: `etag-${url}` }
      }),
    }

    await upload_task_item({
      file: new Blob([new Uint8Array(40 * MB)]),
      size: 40 * MB,
      callbacks,
      transport,
      signal: new AbortController().signal,
      progress_step: 0,
      concurrency: 2,
    })

    expect(peak).toBeLessThanOrEqual(2)
  })
})

describe('upload_task_item：断点续传', () => {
  it('跳过服务端已持有的分片，只补缺失的', async () => {
    state.resume = {
      ... state.resume,
      uploaded_parts: [{ part_number: 1, etag: 'existing', size: 8 * MB }],
    }

    await run(20 * MB)

    expect(state.sign_calls).toEqual([[2, 3]])
    expect(state.puts.map(put => put.url)).toEqual(['https://signed/2', 'https://signed/3'])
    // 完成回报要带上全部三片（含先前已上传的），CompleteMultipartUpload 需要完整清单
    expect(state.completed[0]!.map(part => part.part_number)).toEqual([1, 2, 3])
    expect(state.completed[0]![0]!.etag).toBe('existing')
  })

  it('已全部上传时不发任何 PUT，直接完成', async () => {
    state.resume = {
      ... state.resume,
      uploaded_parts: part_numbers(20 * MB, 8 * MB).map(part_number => ({
        part_number,
        etag: `e${part_number}`,
        size: part_bytes(8 * MB, 20 * MB, part_number),
      })),
    }

    await run(20 * MB)

    expect(state.sign_calls).toEqual([])
    expect(state.puts).toEqual([])
    expect(state.completed[0]).toHaveLength(3)
  })
})

describe('upload_task_item：进度与失败', () => {
  it('按 progress_step 节流上报，最后一定上报一次全量', async () => {
    await run(20 * MB, { progress_step: 9 * MB })

    expect(state.progress.length).toBeGreaterThan(0)
    expect(state.progress.at(- 1)).toBe(20 * MB)
    // 单调不减
    expect([... state.progress].sort((left, right) => left - right)).toEqual(state.progress)
  })

  it('传输失败原样抛出且不报完成', async () => {
    state.put_failure_at = 2

    await expect(run(20 * MB, { concurrency: 1 })).rejects.toThrowError('网络断了')
    expect(state.completed).toEqual([])
  })

  it('开始前已取消：不发任何请求', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(run(20 * MB, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(state.sign_calls).toEqual([])
    expect(state.puts).toEqual([])
  })
})
