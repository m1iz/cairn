export interface HarnessHost<TTurnInput, TResult = void> {
  submitTurn(input: TTurnInput): Promise<TResult>
}
