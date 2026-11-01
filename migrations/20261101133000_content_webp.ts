import { define_migration } from '../scripts/migration/contract'
import { migrate_webp, verify_webp, webp_plan } from './lib/webp-v1/convert'

export default define_migration({ plan: webp_plan, apply: migrate_webp, verify: verify_webp })
