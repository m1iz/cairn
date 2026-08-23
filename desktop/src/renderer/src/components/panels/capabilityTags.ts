import type { SkillInfo } from '../../types'

const TAG_RULES: Array<[string, string[]]> = [
  ['GitHub', ['github', 'gh ', 'pull request', ' pr ', 'issue']],
  ['Search', ['search', 'duckduckgo', 'web search', 'query']],
  ['Design', ['design', 'visual', 'ui', 'ux', 'web artifact', 'html/css']],
  ['Weather', ['weather', 'forecast']],
  ['Image', ['image', 'photo', 'png', 'jpg', 'generate/edit']],
  ['Audit', ['audit', 'review', 'quality', 'security']],
  ['Web', ['web', 'url', 'browser', 'html']],
  ['Agent', ['agent', 'skill', 'subagent']],
  ['Local', ['local', 'file', 'cli', 'terminal']],
]

const TONE_BY_TAG: Record<string, string> = {
  GitHub: 'violet',
  Search: 'cyan',
  Design: 'blue',
  Weather: 'blue',
  Image: 'red',
  Audit: 'gold',
  Web: 'cyan',
  Agent: 'green',
  Local: 'green',
}

export function decorativeTagsForSkill(skill: SkillInfo, limit = 4): string[] {
  const haystack =
    `${skill.name} ${skill.description || ''} ${skill.tags || ''} ${skill.path || ''}`.toLowerCase()
  const tags: string[] = []
  for (const [tag, needles] of TAG_RULES) {
    if (needles.some((needle) => haystack.includes(needle))) {
      tags.push(tag)
    }
    if (tags.length >= limit) break
  }
  return [...new Set(tags)]
}

export function tagTone(tag: string): string {
  const exact = TONE_BY_TAG[tag]
  if (exact) return exact
  const normalized = tag.trim().toLowerCase()
  if (['github', 'gh'].includes(normalized)) return 'violet'
  if (['search', 'web'].includes(normalized)) return 'cyan'
  if (['design', 'ui', 'ux', 'weather'].includes(normalized)) return 'blue'
  if (['audit', 'review', 'always'].includes(normalized)) return 'gold'
  if (['image', 'vision'].includes(normalized)) return 'red'
  return 'green'
}

export function mergedSkillTags(
  skill: SkillInfo,
  limit = 5,
): { visible: string[]; hidden: number } {
  const realTags = parseSkillTags(skill.tags || '')
  const decorative = decorativeTagsForSkill(skill, limit)
  const merged = [...new Set([...realTags, ...decorative])]
  return {
    visible: merged.slice(0, limit),
    hidden: Math.max(0, merged.length - limit),
  }
}

function parseSkillTags(tagStr: string): string[] {
  if (!tagStr) return []
  return tagStr.split(/[,;\s]+/).filter(Boolean)
}
