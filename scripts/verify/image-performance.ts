import type { ImageProcessingOptions } from '@server/lib/webp-image-processing'
import type { Sharp } from 'sharp'
import { readFile, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { basename, resolve } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { load_webp_image_profile } from '@config/loader'
import { process_image_variants } from '@server/lib/webp-image-processing'
import sharp from 'sharp'

/** Deterministic texture, not a photograph or a production workload. */
async function synthetic(width: number, height: number) {
  const bytes = Buffer.alloc(width * height * 3)
  let seed = 17
  for (let y = 0; y < height; y ++) {
    for (let x = 0; x < width; x ++) {
      seed = (1664525 * seed + 1013904223) >>> 0
      const noise = ((seed >>> 24) - 128) * 0.22
      const position = (y * width + x) * 3
      bytes[position] = Math.max(0, Math.min(255, 128 + 70 * Math.sin(x / 31) + noise))
      bytes[position + 1] = Math.max(0, Math.min(255, 128 + 80 * Math.sin(y / 47) + noise))
      bytes[position + 2] = Math.max(0, Math.min(255, 128 + 60 * Math.cos((x + y) / 63) + noise))
    }
  }
  return sharp(bytes, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer()
}

let profiling = false

/** Delegate to the real current pipeline; instrument only this standalone process. */
async function measure(input: Buffer, profile: ImageProcessingOptions) {
  if (profiling)
    throw new Error('Image profiling must run sequentially')
  profiling = true
  const stages: { phase: string, ms: number }[] = []
  const methods = ['metadata', 'toBuffer'] as const
  type Method = (this: Sharp, ... args: unknown[]) => Promise<unknown>
  const prototype = sharp.prototype as unknown as Record<typeof methods[number], Method>
  const originals = { metadata: prototype.metadata, toBuffer: prototype.toBuffer }
  const names = { metadata: ['source_metadata', 'final_metadata'], toBuffer: ['webp', 'jpeg', 'lqip'] }
  const counts = { metadata: 0, toBuffer: 0 }
  const lag = monitorEventLoopDelay({ resolution: 10 })
  const rss_before = process.memoryUsage().rss
  let observed_rss = rss_before
  const sample = () => observed_rss = Math.max(observed_rss, process.memoryUsage().rss)
  const timer = setInterval(sample, 25)
  const cpu = process.cpuUsage()
  const started = performance.now()
  lag.enable()
  try {
    for (const method of methods) {
      prototype[method] = async function (... args) {
        const phase = names[method][counts[method] ++]
        const start = performance.now()
        try {
          return await Reflect.apply(originals[method], this, args)
        }
        finally {
          stages.push({ phase: phase ?? `unexpected_${method}`, ms: performance.now() - start })
          sample()
        }
      }
    }
    const variants = await process_image_variants(input, profile)
    const wall_ms = performance.now() - started
    const cpu_us = process.cpuUsage(cpu)
    if (counts.metadata !== 2 || counts.toBuffer !== 3)
      throw new Error('Image pipeline changed; review phase labels before using this benchmark')
    return { variants, timing: { wall_ms, stages, cpu_ms: (cpu_us.user + cpu_us.system) / 1000,
      rss_before_bytes: rss_before, rss_observed_max_bytes: observed_rss, event_loop_max_ms: lag.max / 1e6 } }
  }
  finally {
    for (const method of methods)
      prototype[method] = originals[method]
    clearInterval(timer)
    lag.disable()
    profiling = false
  }
}

async function pixels(bytes: Buffer, profile: ImageProcessingOptions) {
  return sharp(bytes, { limitInputPixels: profile.maxPixels, failOn: 'warning' })
    .timeout({ seconds: profile.timeoutSeconds }).autoOrient().toColourspace('srgb')
    .flatten({ background: profile.jpegBackground }).removeAlpha().raw().toBuffer()
}

/** PSNR on flattened sRGB pixels; null means identical, not a perceptual score. */
function psnr(reference: Buffer, output: Buffer) {
  if (reference.length !== output.length)
    throw new Error('Decoded dimensions differ')
  let squared_error = 0
  for (let index = 0; index < reference.length; index ++)
    squared_error += (reference[index]! - output[index]!) ** 2
  return squared_error ? 10 * Math.log10(255 ** 2 / (squared_error / reference.length)) : null
}

export async function image_performance(args: string[]) {
  const { values } = parseArgs({ args, options: {
    input: { type: 'string', multiple: true }, output: { type: 'string' },
    runs: { type: 'string', default: '2' }, efforts: { type: 'string', default: '4,2,0' }, quality: { type: 'boolean', default: false },
  } })
  const runs = Number(values.runs)
  const efforts = values.efforts!.split(',').map(Number)
  if (! Number.isSafeInteger(runs) || runs < 1 || runs > 5 || ! efforts.length
    || values.efforts!.split(',').some(value => ! /^[0-6]$/.test(value)) || new Set(efforts).size !== efforts.length) {
    throw new Error('Use 1-5 runs and distinct WebP efforts from 0 to 6')
  }
  const environment = process.env.NODE_ENV ?? 'development'
  const { profile, profile_version } = load_webp_image_profile({ NODE_ENV: environment })
  const records = []
  const inputs = values.input?.length
    ? values.input.map(path => ({ label: basename(path), load: () => readFile(path) }))
    : [
        { label: '1MP-texture', load: () => synthetic(1280, 800) },
        { label: '3.8MP-texture', load: () => synthetic(2400, 1600) },
      ]
  for (const input of inputs) {
    const bytes = await input.load()
    if (! bytes.length || bytes.length > profile.maxInputBytes)
      throw new Error('Input exceeds the configured byte budget')
    const reference = values.quality ? await pixels(bytes, profile) : null
    for (const effort of efforts) {
      for (let run = 0; run < runs; run ++) {
        const { variants, timing } = await measure(bytes, { ... profile, webpEffort: effort })
        records.push({ label: input.label, effort, run, width: variants.width, height: variants.height,
          input_bytes: bytes.length, webp_bytes: variants.display.length, jpeg_bytes: variants.fallback.length, lqip_bytes: variants.lqip.length,
          ... timing, ... (reference ? { psnr_db: psnr(reference, await pixels(variants.display, profile)) } : {}) })
      }
    }
  }
  const report = { environment: { node: process.version, platform: process.platform, arch: process.arch,
    parallelism: availableParallelism(), sharp: sharp.versions.sharp, vips: sharp.versions.vips, aom: sharp.versions.aom,
    sharp_concurrency: sharp.concurrency(), uv_threadpool_size: process.env.UV_THREADPOOL_SIZE ?? 'default',
    configuration_environment: environment, profile_version, profile }, records }
  if (values.output)
    await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  image_performance(process.argv.slice(2)).then(report => console.log(JSON.stringify(report, null, 2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Image benchmark failed')
    process.exitCode = 1
  })
}
