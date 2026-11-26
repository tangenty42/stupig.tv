export interface ContentDeleteTarget {
  path: string
  kind: 'file' | 'folder' | 'story'
  /** This public 删减版 also serves references to its paired private file. */
  redaction_of?: string
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
