export interface ContentDeleteTarget {
  path: string
  kind: 'file' | 'folder' | 'story'
}

export interface ContentDeleteReference {
  target: string
  line: number
  effect: 'missing' | 'contents'
}

export interface ContentDeleteSource {
  story_id: number
  title: string
  references: ContentDeleteReference[]
}

export interface ContentDeleteImpact {
  targets: ContentDeleteTarget[]
  sources: ContentDeleteSource[]
  cloud_draft_references?: boolean
}
