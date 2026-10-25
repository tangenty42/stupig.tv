import { define_migration } from '../scripts/migration/contract'
import { migrate_workspace, verify_workspace, workspace_plan } from './lib/content-v1/workspace'

export default define_migration({ plan: workspace_plan, apply: migrate_workspace, verify: verify_workspace })
