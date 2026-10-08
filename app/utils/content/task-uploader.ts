import type { ContentTaskPart, ContentTaskResumeState, ContentTaskUploadedPart } from '@shared/types/content'

/**
 * The attachment uploader that replaced Uppy (docs/content-task-refactor.md §9).
 *
 * It is deliberately thin: the server owns the task, the staging key, the part
 * plan and the resume state, so this module only
 *   1. asks for parts to be signed (in server-sized batches),
 *   2. PUTs their bytes through an injected transport (XHR in the browser,
 *      a stub in tests) while reporting progress,
 *   3. reports completion with the ETags it collected.
 *
 * Everything here is transport-agnostic and abortable, which is what makes
 * resume a matter of calling it again: the parts the server already holds are
 * skipped, so only what is missing goes out.
 */

export interface UploadTransport {
  /**
   * PUTs one chunk and resolves with the response ETag. Must reject on a
   * non-2xx response and on abort.
   */
  put: (input: {
    url: string
    body: Blob
    signal: AbortSignal
    on_progress: (sent: number) => void
  }) => Promise<{ etag: string }>
}

export interface UploadTaskCallbacks {
  /** Signs the given part numbers; the server caps the batch size. */
  sign_parts: (part_numbers: number[]) => Promise<{ parts: ContentTaskPart[] }>
  /** Reports bytes of progress; also the liveness signal that renews the task lease. */
  report_progress: (bytes_done: number) => Promise<void>
  /** Reports the finished item with its part inventory (the single PUT's ETag included). */
  report_completed: (parts: ContentTaskUploadedPart[]) => Promise<void>
  /** Current task state on the server, so a retry continues instead of restarting. */
  fetch_resume_state: () => Promise<ContentTaskResumeState>
}

export interface UploadTaskInput {
  file: Blob
  size: number
  callbacks: UploadTaskCallbacks
  transport: UploadTransport
  signal: AbortSignal
  /** Parts uploaded concurrently within a batch. */
  concurrency?: number
  /** Report progress only after this many more bytes have landed. */
  progress_step?: number
}

const default_concurrency = 3
const default_progress_step = 2 * 1024 * 1024
const default_sign_batch_size = 20
const min_part_size = 5 * 1024 * 1024

/** Bytes of one part, clamped to what is left (the last part is usually short). */
export function part_bytes(part_size: number, size: number, part_number: number) {
  return Math.min(part_size, size - (part_number - 1) * part_size)
}

/** Part numbers a file of `size` splits into under `part_size`. */
export function part_numbers(size: number, part_size: number) {
  const total = Math.max(1, Math.ceil(size / part_size))
  return Array.from({ length: total }, (_, index) => index + 1)
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size)
    batches.push(items.slice(index, index + size))
  return batches
}

/** Runs `worker` over `items` with at most `limit` in flight; a rejection aborts the rest. */
async function run_bounded<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  const queue = [... items]
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length)
      await worker(queue.shift()!)
  })
  await Promise.all(runners)
}

function throw_if_aborted(signal: AbortSignal) {
  if (! signal.aborted)
    return
  const error = new Error('上传已取消')
  error.name = 'AbortError'
  throw error
}

/**
 * Uploads one task item's bytes.
 *
 * An item with no multipart upload goes out as a single PUT; otherwise the
 * parts go in batches, each batch signed immediately before its uploads, so a
 * signed URL cannot expire while the client is still working through the file.
 */
export async function upload_task_item(input: UploadTaskInput): Promise<void> {
  const concurrency = Math.max(1, input.concurrency ?? default_concurrency)
  const progress_step = input.progress_step ?? default_progress_step
  throw_if_aborted(input.signal)

  const resume = await input.callbacks.fetch_resume_state()
  // A part size below the service's floor means the item was prepared for a
  // single PUT: multipart parts must clear 5 MiB.
  const part_size = resume.part_size && resume.part_size >= min_part_size ? resume.part_size : null

  if (! resume.upload_id || ! part_size) {
    const signed = await input.callbacks.sign_parts([1])
    throw_if_aborted(input.signal)
    const { etag } = await input.transport.put({
      url: signed.parts[0]!.url,
      body: input.file,
      signal: input.signal,
      on_progress: (sent) => {
        void input.callbacks.report_progress(Math.min(sent, input.size))
      },
    })
    // A single PUT has no part list; the ETag is still reported so both paths
    // hand the server the same shape.
    await input.callbacks.report_completed([{ part_number: 1, etag, size: input.size }])
    return
  }

  const uploaded = new Map(resume.uploaded_parts.map(part => [part.part_number, part]))
  const missing = part_numbers(input.size, part_size).filter(part_number => ! uploaded.has(part_number))

  let bytes_confirmed = resume.uploaded_parts.reduce((sum, part) => sum + part.size, 0)
  let bytes_in_flight = 0
  let bytes_reported = bytes_confirmed

  const flush_progress = async (force: boolean) => {
    const progress = bytes_confirmed + bytes_in_flight
    if (! force && progress - bytes_reported < progress_step)
      return
    bytes_reported = progress
    await input.callbacks.report_progress(progress)
  }

  const batch_size = Math.max(1, resume.sign_batch_size || default_sign_batch_size)

  for (const batch of chunk(missing, batch_size)) {
    throw_if_aborted(input.signal)
    const signed = await input.callbacks.sign_parts(batch)
    const urls = new Map(signed.parts.map(part => [part.part_number, part.url]))
    await run_bounded(batch, concurrency, async (part_number) => {
      const url = urls.get(part_number)
      if (! url)
        throw new Error('上传分片未获得签名')
      const size = part_bytes(part_size, input.size, part_number)
      const offset = (part_number - 1) * part_size
      bytes_in_flight += size
      try {
        const { etag } = await input.transport.put({
          url,
          body: input.file.slice(offset, offset + size),
          signal: input.signal,
          on_progress: (sent) => {
            bytes_in_flight = bytes_in_flight - size + Math.min(sent, size)
            void flush_progress(false)
          },
        })
        uploaded.set(part_number, { part_number, etag, size })
        bytes_in_flight -= size
        bytes_confirmed += size
        await flush_progress(false)
      }
      catch (error) {
        bytes_in_flight -= size
        throw error
      }
    })
  }

  throw_if_aborted(input.signal)
  await flush_progress(true)
  const parts = [... uploaded.values()].sort((left, right) => left.part_number - right.part_number)
  await input.callbacks.report_completed(parts)
}
