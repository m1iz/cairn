export type PermissionRuleAction = 'allow' | 'ask' | 'deny'
export type PermissionRuleTrust =
  | 'system'
  | 'managed'
  | 'user'
  | 'project'
  | 'runtime'
  | 'untrusted'
  | 'unknown'

export interface PermissionRuleSource {
  kind: string
  id: string
  trust: PermissionRuleTrust
}

export interface PermissionRuleCandidate {
  id: string
  action: PermissionRuleAction
  matched: boolean
  source: PermissionRuleSource
  precedence: string
}
