import { describe, expect, it } from 'vitest'
import type { SkillInfo } from '../../types'
import { decorativeTagsForSkill, tagTone } from './capabilityTags'

describe('capability tags', () => {
  it('derives bounded decorative tags from skill metadata', () => {
    const skill: SkillInfo = {
      name: 'github-web-design-audit',
      description:
        'Audit GitHub projects and produce high-quality visual Web artifacts.',
      path: 'skills/github-web-design-audit/SKILL.md',
      tags: 'always design',
    }

    const tags = decorativeTagsForSkill(skill)

    expect(tags).toContain('GitHub')
    expect(tags).toContain('Design')
    expect(tags).toContain('Audit')
    expect(tags.length).toBeLessThanOrEqual(4)
    expect(new Set(tags).size).toBe(tags.length)
  })

  it('maps decorative tags to stable color tones', () => {
    expect(tagTone('GitHub')).toBe('violet')
    expect(tagTone('Search')).toBe('cyan')
    expect(tagTone('Weather')).toBe('blue')
    expect(tagTone('Audit')).toBe('gold')
    expect(tagTone('Local')).toBe('green')
  })
})
