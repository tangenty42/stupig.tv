import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { load_environment } from '../../config/lib/environment.mjs'
import { create_api } from '../esa/api'
import { load_publish_config, require_publish_credentials } from '../esa/config'
import { inspect_dev_esa } from '../esa/dev-status'

/** Run the optional network check separately so it cannot delay Nuxt startup. */
export function start_dev_esa_notice(env: NodeJS.ProcessEnv) {
  let child: ChildProcess
  try {
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
      env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
    })
    child.once('error', () => console.warn('[dev-esa] 无法启动只读版本检查；开发服务不受影响。'))
  }
  catch {
    console.warn('[dev-esa] 无法启动只读版本检查；开发服务不受影响。')
    return () => {}
  }
  return () => child.kill()
}

async function report_dev_esa() {
  try {
    const config = load_publish_config(load_environment({ node_env: 'development' }))
    require_publish_credentials(config)
    const status = await inspect_dev_esa(config, create_api(config), await readFile(config.entry))
    if (status.source === 'differs')
      console.warn(`[dev-esa] 开发 ESA ${status.evidence === 'receipt' ? '活动版本的本机发布记录' : '函数源码或版本摘要'}与本地源码不一致；需要更新时运行 pnpm esa:deploy:dev。`)
    if (status.configuration === 'differs')
      console.warn('[dev-esa] 开发 ESA 函数非机密配置与本地不一致；需要更新时运行 pnpm esa:deploy:dev。')
    if (status.source === 'unverifiable')
      console.warn('[dev-esa] 无法核对在线源码：版本未稳定、旧版本缺少源码摘要或身份缺少读取源码的权限。')
    if (status.source === 'matches' && status.configuration === 'matches')
      console.log(`[dev-esa] 开发函数${status.evidence === 'receipt' ? '活动版本的本机发布记录' : '源码或版本摘要'}和非机密配置与本地一致。`)
    console.log('[dev-esa] 加密密钥无法只读比对；附件是否可用仍需实际验证。')
  }
  catch {
    // SDK and configuration errors can contain credentials or request data.
    console.warn('[dev-esa] 无法完成只读检查（配置、权限或网络异常）；开发服务不受影响。可运行 pnpm esa:deploy:dev --check 排查。')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await report_dev_esa()
