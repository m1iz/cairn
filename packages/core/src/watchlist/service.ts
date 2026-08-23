import { nowTs } from '../util/time'
import type { TokenTracker } from '../memory/token-tracker'
import type { ModelRouter, ProviderSnapshot } from '../model/router'
import type { LLMResponse } from '../providers/base'
import {
  decisionPrompt,
  parseWatchlistDecision,
  WatchlistDecision,
} from './models'
import { WatchlistStore } from './store'

export type WatchlistDecisionFn = (
  content: string,
  items: string[],
) => WatchlistDecision | Promise<WatchlistDecision>

export class WatchlistService {
  readonly root: string
  readonly store: WatchlistStore
  decider: WatchlistDecisionFn | null
  modelRouter: ModelRouter | null
  tokenTracker: TokenTracker | null

  constructor(
    root: string,
    opts: {
      decider?: WatchlistDecisionFn | null
      modelRouter?: ModelRouter | null
      tokenTracker?: TokenTracker | null
    } = {},
  ) {
    this.root = root
    this.store = new WatchlistStore(root)
    this.decider = opts.decider ?? null
    this.modelRouter = opts.modelRouter ?? null
    this.tokenTracker = opts.tokenTracker ?? null
  }

  payload(): Record<string, unknown> {
    return this.store.payload()
  }
  read(): string {
    return this.store.read()
  }
  write(content: string): Record<string, unknown> {
    this.store.write(content)
    return this.payload()
  }

  async check(): Promise<WatchlistDecision> {
    const content = this.store.read()
    const items = this.store.activeItems()
    if (!items.length) {
      const decision = WatchlistDecision.skip('watchlist has no active items')
      this.store.writeDecision(decision)
      return decision
    }
    const decision = this.decider
      ? await this.decider(content, items)
      : await this.decideWithModel(content, items)
    decision.checked_at = decision.checked_at || nowTs()
    this.store.writeDecision(decision)
    return decision
  }

  private async decideWithModel(
    content: string,
    items: string[],
  ): Promise<WatchlistDecision> {
    if (!this.modelRouter)
      return WatchlistDecision.skip('model router is unavailable')
    const route = this.modelRouter.route('watchlist_check', undefined, content)
    const snapshot = route.snapshot
    const resp: LLMResponse = await callSnapshot(snapshot, content, items)
    this.tokenTracker?.record(snapshot.model, resp.usage, {
      provider: snapshot.providerName,
      usageType: 'watchlist_check',
      modelEntryId: snapshot.modelEntryId,
      routeReason: snapshot.routeReason,
    })
    const decision = parseWatchlistDecision(resp.content || '')
    decision.model = snapshot.model
    decision.provider = snapshot.providerName
    decision.model_entry_id = snapshot.modelEntryId ?? snapshot.entryName
    return decision
  }
}

async function callSnapshot(
  snapshot: ProviderSnapshot,
  content: string,
  items: string[],
): Promise<LLMResponse> {
  return snapshot.provider.chat({
    model: snapshot.model,
    maxTokens: Math.min(1200, snapshot.generation.maxTokens),
    temperature: 0,
    reasoningEffort: snapshot.generation.reasoningEffort,
    messages: decisionPrompt({ content, items }),
    tools: null,
  })
}
