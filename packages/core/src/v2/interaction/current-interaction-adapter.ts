import type {
  InteractionControlPayload,
  InteractionPayload,
  InteractionPort,
  InteractionResumeOptions,
} from '../contracts/interaction'

export interface CurrentInteractionSurface {
  get(): unknown
  setMode(mode: string): unknown | Promise<unknown>
  setPermissionMode(mode: string): unknown | Promise<unknown>
  answerInteraction(
    id: string,
    answers: InteractionPayload,
    options?: InteractionResumeOptions,
  ): Promise<InteractionPayload>
  commentPlan(
    id: string,
    comment: string,
    options?: InteractionResumeOptions,
  ): Promise<InteractionPayload>
  approvePlan(
    id: string,
    options?: InteractionResumeOptions,
  ): Promise<InteractionPayload>
  cancelInteraction(id: string): Promise<InteractionPayload>
}

export class CurrentInteractionAdapter implements InteractionPort {
  constructor(private readonly current: CurrentInteractionSurface) {}

  get(): InteractionControlPayload {
    return this.current.get() as InteractionControlPayload
  }

  async setMode(mode: string): Promise<InteractionControlPayload> {
    return (await this.current.setMode(mode)) as InteractionControlPayload
  }

  async setPermissionMode(mode: string): Promise<InteractionControlPayload> {
    return (await this.current.setPermissionMode(
      mode,
    )) as InteractionControlPayload
  }

  answer(
    id: string,
    answers: InteractionPayload,
    options?: InteractionResumeOptions,
  ): Promise<InteractionPayload> {
    return this.current.answerInteraction(id, answers, options)
  }

  comment(
    id: string,
    comment: string,
    options?: InteractionResumeOptions,
  ): Promise<InteractionPayload> {
    return this.current.commentPlan(id, comment, options)
  }

  approve(
    id: string,
    options?: InteractionResumeOptions,
  ): Promise<InteractionPayload> {
    return this.current.approvePlan(id, options)
  }

  cancel(id: string): Promise<InteractionPayload> {
    return this.current.cancelInteraction(id)
  }
}
