import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'ChatView.vue'), 'utf8')

describe('ChatView model activation', () => {
  it('opens the profile interview returned by activating the first usable model', () => {
    expect(source).toContain('payload.profileOnboarding?.started')
    expect(source).toContain('ctx.openProfileInterviewSession')
    expect(source).toContain('payload.profileOnboarding.state.sessionId')
  })
})
