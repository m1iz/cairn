export interface ContextFragment {
  id: string
  kind: string
  source: string
  content: string
}

export interface ContextDecision {
  id: string
  kind: string
  source: string
  action: 'include' | 'omit'
  reason: string
}

export interface ContextOmission {
  kind: string
  source: string
  reason: string
}

export interface ContextAssemblyEntry {
  id: string
  kind: string
  source: string
  reason: string
  fragmentId?: string
}

export interface ContextAssemblyResult {
  prompt: string
  rendered: ContextAssemblyEntry[]
  omitted: ContextAssemblyEntry[]
}
