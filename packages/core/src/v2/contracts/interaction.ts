export type InteractionPayload = Record<string, unknown>

export interface InteractionControlPayload extends InteractionPayload {
  mode: string
}

export interface InteractionResumeOptions {
  clientMessageId?: string | null
  turnId?: string | null
  displayContent?: string | null
  uiHidden?: boolean | null
  delivery?: 'queue' | 'interject' | null
}

export interface InteractionPort {
  get(): InteractionControlPayload
  setMode(mode: string): Promise<InteractionControlPayload>
  setPermissionMode(mode: string): Promise<InteractionControlPayload>
  answer(
    id: string,
    answers: InteractionPayload,
    options?: InteractionResumeOptions,
  ): Promise<InteractionPayload>
  comment(
    id: string,
    comment: string,
    options?: InteractionResumeOptions,
  ): Promise<InteractionPayload>
  approve(
    id: string,
    options?: InteractionResumeOptions,
  ): Promise<InteractionPayload>
  cancel(id: string): Promise<InteractionPayload>
}
