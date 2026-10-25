export type NodeEnvironment = 'development' | 'production'
export function environment_file(node_env: string | undefined): '.env.dev' | '.env.prod'
export function load_environment(options?: { env?: NodeJS.ProcessEnv, cwd?: string, node_env?: string }): NodeJS.ProcessEnv & { NODE_ENV: NodeEnvironment }
export function prepare_cli_environment(argv: string[], env?: NodeJS.ProcessEnv, cwd?: string): {
  args: string[]
  node_env: NodeEnvironment
  filename: '.env.dev' | '.env.prod'
  env: NodeJS.ProcessEnv & { NODE_ENV: NodeEnvironment }
}
export function initialize_cli_environment(): ReturnType<typeof prepare_cli_environment>
