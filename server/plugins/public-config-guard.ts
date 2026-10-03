import { load_config, runtime_injected_public } from '@shared/config'

// public 配置里凡是构建期烘焙不了的值（构建机没有 .env），都只能靠容器启动时的
// NUXT_PUBLIC_* 注入。漏注入不会自己报错：页面照常打开，只有浏览器静默连不上 broker，
// 所以这里把它变成启动失败，让容器用重启循环和一条点名的错误喊出来。
// load_config() 顺带把"密钥/连接信息缺失、JWT 过短、URL 不合法"也提前到了启动时。
export default defineNitroPlugin(() => {
  const public_config = useRuntimeConfig().public as Record<string, unknown>
  const expected = runtime_injected_public(load_config())
  const problems: string[] = []

  for (const [key, value] of Object.entries(expected)) {
    if (public_config[key] !== value) {
      problems.push(`${key} 应为 ${JSON.stringify(value)}，实际是 ${JSON.stringify(public_config[key])}（运行期注入用 ${env_key(key)}）`)
    }
  }

  // 兜底：表外还剩空串，说明白名单新增了插值字段却没补进上表，或者 config/*.yaml 里
  // 本该有形值的字段被清空了。只认空字符串——白名单里有 false / 0 这类合法假值。
  for (const [key, value] of Object.entries(public_config)) {
    if (value === '' && ! (key in expected)) {
      problems.push(`${key} 为空：白名单里没有"可以为空"的语义，插值字段请补进 runtime_injected_public（运行期注入用 ${env_key(key)}），字面量字段检查 config/*.yaml`)
    }
  }

  if (problems.length) {
    throw new Error(`public 配置需要运行期注入：${problems.join('；')}`)
  }
})

// Nuxt 把 runtimeConfig.public.foo_bar 映射成 NUXT_PUBLIC_FOO_BAR
function env_key(key: string) {
  return `NUXT_PUBLIC_${key.toUpperCase()}`
}
