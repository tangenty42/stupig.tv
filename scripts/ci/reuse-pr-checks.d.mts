export interface CheckJob {
  name: string
  status: string
  conclusion: string | null
}

export function verified_jobs(jobs: CheckJob[], tree: string): boolean
export function has_verified_pr(options: {
  api: (path: string) => Promise<unknown>
  repository: string
  sha: string
  tree: string
}): Promise<boolean>
