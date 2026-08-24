export interface HarnessHost<TTurnInput, TResult = void> {
  submitTurn(input: TTurnInput): Promise<TResult>
}

export class CallbackHarnessHost<
  TTurnInput,
  TResult = void,
> implements HarnessHost<TTurnInput, TResult> {
  constructor(
    private readonly submit: (input: TTurnInput) => Promise<TResult>,
  ) {}

  submitTurn(input: TTurnInput): Promise<TResult> {
    return this.submit(input)
  }
}
