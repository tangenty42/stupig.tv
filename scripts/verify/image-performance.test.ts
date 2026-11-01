import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { expect, it, vi } from 'vitest'
import { image_performance } from './image-performance'

it('benchmarks the real CLI without deployment credentials and keeps its report internally consistent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stupig-image-benchmark-'))
  try {
    const input = join(directory, 'fixture.png')
    const output = join(directory, 'report.json')
    await writeFile(input, await sharp({ create: { width: 8, height: 4, channels: 4, background: '#ff000080' } }).png().toBuffer())
    const run = promisify(execFile)
    const { stdout } = await run(process.execPath, [fileURLToPath(import.meta.resolve('tsx/cli')), '--tsconfig', 'scripts/tsconfig.json', 'scripts/verify/image-performance.ts', '--input', input, '--output', output, '--efforts', '0,2', '--runs', '1', '--quality'], {
      env: { ... process.env, NODE_ENV: 'development' }, windowsHide: true, timeout: 20_000,
    })
    const report = JSON.parse(stdout)
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(report)
    expect(report.records).toHaveLength(2)
    expect(report.records.map((row: { effort: number }) => row.effort)).toEqual([0, 2])
    for (const row of report.records) {
      expect(row).toMatchObject({ label: 'fixture.png', width: 8, height: 4, run: 0 })
      expect(row.wall_ms).toBeGreaterThanOrEqual(row.stages.reduce((sum: number, stage: { ms: number }) => sum + stage.ms, 0))
      expect(row.stages.map((stage: { phase: string }) => stage.phase)).toEqual(['source_metadata', 'webp', 'jpeg', 'lqip', 'final_metadata'])
      expect(row.webp_bytes).toBeGreaterThan(0)
      expect(row.jpeg_bytes).toBeGreaterThan(0)
      expect(row.lqip_bytes).toBeGreaterThan(0)
      expect(row.rss_observed_max_bytes).toBeGreaterThanOrEqual(row.rss_before_bytes)
      expect(row.psnr_db === null || Number.isFinite(row.psnr_db)).toBe(true)
    }
    expect(stdout).not.toContain(directory)
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 25_000)

it('restores Sharp instrumentation after a rejected source and rejects invalid work budgets', async () => {
  vi.stubEnv('NODE_ENV', 'development')
  const directory = await mkdtemp(join(tmpdir(), 'stupig-image-benchmark-'))
  const original = { metadata: sharp.prototype.metadata, toBuffer: sharp.prototype.toBuffer }
  try {
    const input = join(directory, 'unsupported.svg')
    await writeFile(input, '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')
    await expect(image_performance(['--input', input, '--efforts', '0', '--runs', '1'])).rejects.toThrow('暂不支持')
    expect(sharp.prototype.metadata).toBe(original.metadata)
    expect(sharp.prototype.toBuffer).toBe(original.toBuffer)
    for (const args of [['--runs', '0'], ['--runs', '6'], ['--efforts', '4,4'], ['--efforts', '10'], ['--efforts', '']])
      await expect(image_performance(args)).rejects.toThrow('Use 1-5 runs')
  }
  finally {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  }
})
