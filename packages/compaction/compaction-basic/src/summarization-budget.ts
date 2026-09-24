/**
 * Size budget for the replayed prefix one summarization request may carry.
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarization-budget
 */

/**
 * Hard ceiling on the input one summarization request may carry, in tokens.
 * The OpenAI-compatible gateway in front of this deployment's routes refuses a
 * larger request with `context_length_exceeded` whatever the route declares:
 * measured 2026-09-22, an 800015-token request was refused with "exceeds safe
 * context budget 516096" while the same route declares 524288. A fixed
 * deployment invariant rather than a per-route policy value.
 */
const HARD_INPUT_TOKEN_CEILING = 516_096

/** Fraction of the request budget held back for token-estimate error. */
export const SUMMARIZATION_INPUT_SAFETY_RATIO = 0.92

/** Smallest usable input budget, so a tiny context window still yields a range. */
const MINIMUM_INPUT_BUDGET = 512

/**
 * Largest replayed prefix one summarization request may send for a route. The
 * declared capacity bounds it first, less the output the summarization call
 * reserves, and the gateway ceiling bounds it whatever the declaration says: a
 * route declaring 1000000 with an 8192-token reservation budgets about 912000,
 * one declaring 524288 budgets about 466000.
 * @param contextWindow - the route's declared combined request and response capacity in tokens.
 * @param maxTokens - output tokens the summarization call reserves.
 * @returns the input budget in tokens, held below the route's request ceiling.
 */
export function summarizationInputBudget(contextWindow: number, maxTokens: number): number {
  const output = Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : 0
  const input = Math.min(contextWindow, HARD_INPUT_TOKEN_CEILING)
  return Math.max(
    MINIMUM_INPUT_BUDGET,
    Math.floor((input - output) * SUMMARIZATION_INPUT_SAFETY_RATIO),
  )
}

/**
 * Most tokens an overflow-triggered summarization may replay when the route
 * declares no capacity. The overflowing request's own price is the only
 * evidence available: it already fits the ceiling, so a replay bounded by a
 * fraction of that price cannot exceed the ceiling either.
 * @param measuredTokens - the overflowing request's priced total in tokens.
 * @returns a replay budget derived from that measurement.
 */
export function overflowSummarizationInputBudget(measuredTokens: number): number {
  return Math.min(
    HARD_INPUT_TOKEN_CEILING,
    Math.max(
      MINIMUM_INPUT_BUDGET,
      Math.floor(measuredTokens * SUMMARIZATION_INPUT_SAFETY_RATIO),
    ),
  )
}
