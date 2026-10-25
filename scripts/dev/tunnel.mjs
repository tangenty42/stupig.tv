// Compatibility entry: pnpm dev:tunnel supplies the tsx loader.
import { handle_tunnel_signals, run_dev_tunnel } from './frp.ts'

try {
  handle_tunnel_signals(await run_dev_tunnel())
}
catch (error) {
  console.error(`[dev-auth] ${error.message}`)
  process.exitCode = 1
}
