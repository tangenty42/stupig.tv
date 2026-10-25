import { define_migration } from '../scripts/migration/contract'
import { migrate_references, reference_plan, verify_references } from './lib/content-v1/references'

export default define_migration({ plan: reference_plan, apply: migrate_references, verify: verify_references })
