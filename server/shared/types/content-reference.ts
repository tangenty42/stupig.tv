export interface ContentReferenceBaseline {
  base_namespace_revision: number | null
  base_title_revision: number | null
}

export interface ContentReferenceDiagnostic {
  kind: 'attachment' | 'story'
  target: string
  from: number
  to: number
  line: number
  reason: 'missing'
}

export interface ContentReferenceRewriteResult extends ContentReferenceBaseline {
  markdown: string
  changes: { from: number, to: number, insert: string }[]
  namespace_revision: number
  title_revision: number
  baseline_unavailable: { namespace: boolean, title: boolean }
  diagnostics: ContentReferenceDiagnostic[]
}

/** One transaction's simultaneous changes. Deletion records retain the old identity. */
export interface ContentReferenceChange {
  node_id: number
  from: string
  to: string | null
  is_folder?: boolean
}

export interface ContentReferenceJournal {
  revision: number
  changes: ContentReferenceChange[]
}
