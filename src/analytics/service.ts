/**
 * Allocation-suggestion service (#322) — the DB glue around the pure core.
 *
 * ─── THE ADVISORY INVARIANT ──────────────────────────────────────────────────
 *
 * This module MUST NOT write User.strategyConfig, User.rebalanceStrategy, or any
 * other field the agent loop reads. A suggestion is computed, persisted to
 * AllocationSuggestion, and returned for display. Applying it is a separate,
 * deliberate act by the user through the existing strategy update path, which
 * already validates the config (publishableConfigSchema) and already logs the
 * change.
 *
 * That is not a convention — tests/unit/analytics/structural.test.ts scans this
 * file's source text and fails on any `user.update`, `strategyConfig` write, or
 * `src/stellar/` import. The reason for the paranoia: an optimizer that can
 * silently rewrite where someone's money sits is a fundamentally different and
 * far more dangerous feature than one that draws a chart.
 *
 * ─── PRECEDENCE, MIRRORED EXACTLY FROM THE AGENT ─────────────────────────────
 *
 * The agent resolves a user's effective risk ceiling with TWO deliberately
 * different merge rules, and a suggestion that used a third would be advice
 * about a portfolio the agent will never build. So both are mirrored verbatim:
 *
 *   1. A FOLLOWED strategy merges via stricterRiskCeiling (Math.max — higher
 *      score means lower risk, so a follow may only ever TIGHTEN a follower's
 *      exposure). See src/agent/effectiveStrategy.ts.
 *   2. An ACTIVE SavingsGoal then OVERRIDES via `??`, matching
 *      src/agent/router.ts — a stated personal target outranks a copied config,
 *      and it may legitimately loosen the ceiling.
 *
 * Unifying these into one rule would be tidier and wrong.
 */

import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import db from '../db'
import { logger } from '../utils/logger'
import { buildDailyRateSeries, runBacktest } from '../agent/backtest'
import { TargetAllocationStrategy } from '../agent/strategies'
import {
  parseStrategyConfig,
  stricterRiskCeiling,
} from '../agent/effectiveStrategy'
import { estimate, DEFAULT_LOOKBACK_DAYS } from './estimation'
import { optimize, toPercentageAllocations } from './optimizer'
import {
  AllocationSuggestionResult,
  BacktestComparison,
  OptimizationOutcome,
  RawRateObservation,
  RiskScoreRow,
} from './types'

/**
 * Notional starting capital for the backtest comparison when the user has no
 * position value to anchor to. The comparison is about RELATIVE performance of
 * two configs over identical history, so the absolute figure is arbitrary —
 * fixed rather than random so the same inputs give the same output.
 */
const DEFAULT_BACKTEST_NOTIONAL = 10_000

/**
 * The caveat that ships with every backtest comparison. Not optional garnish:
 * without it the comparison reads as "this allocation would have earned X",
 * which is not what was simulated. See computeBacktestComparison.
 */
export const BACKTEST_CAVEAT =
  'The agent holds one protocol at a time, so this compares what the agent WOULD HAVE DONE under each configuration — it is not a simulation of holding the weighted basket.'

/** The advisory disclaimer returned with every suggestion. */
export const ADVISORY_DISCLAIMER =
  'This is a suggestion only. It has not changed your strategy, and no funds have moved. Optimization minimizes YIELD volatility from historical APY data; it does not model principal loss, depeg, or smart-contract failure.'

export class SuggestionUserNotFoundError extends Error {
  constructor(userId: string) {
    super(`User ${userId} not found`)
    this.name = 'SuggestionUserNotFoundError'
  }
}

interface EffectiveInputs {
  riskTolerance: number
  effectiveRiskCeiling: number | undefined
  currentAllocations: Record<string, number> | undefined
  /** Which layer supplied the ceiling — surfaced so the API can explain it. */
  ceilingSource: 'goal' | 'follow' | 'own' | 'none'
}

/**
 * Resolve the user's effective optimizer inputs from their own config, the
 * config they follow, and any ACTIVE savings goal. Pure precedence logic; the
 * three reads are done by the caller so this stays independently testable.
 */
export function resolveEffectiveInputs(
  riskTolerance: number,
  ownConfigRaw: unknown,
  followedConfigRaw: unknown | null,
  goalRiskCeiling: number | null
): EffectiveInputs {
  const own = parseStrategyConfig(ownConfigRaw)
  const followed = followedConfigRaw
    ? parseStrategyConfig(followedConfigRaw)
    : null

  // Rule 1: a follow may only tighten.
  const merged = stricterRiskCeiling(own.riskCeiling, followed?.riskCeiling)

  // Rule 2: an active goal overrides outright.
  const effectiveRiskCeiling = goalRiskCeiling ?? merged

  const ceilingSource: EffectiveInputs['ceilingSource'] =
    goalRiskCeiling !== null && goalRiskCeiling !== undefined
      ? 'goal'
      : merged === undefined
        ? 'none'
        : followed?.riskCeiling !== undefined && merged === followed.riskCeiling
          ? 'follow'
          : 'own'

  // A follow replaces allocations WHOLESALE, never key-by-key — pairing a
  // publisher's strategy with a follower's leftover allocations would produce a
  // configuration neither party chose (src/agent/effectiveStrategy.ts).
  const currentAllocations = followed?.strategyName
    ? followed.targetAllocations
    : (followed?.targetAllocations ?? own.targetAllocations)

  return {
    riskTolerance,
    effectiveRiskCeiling,
    currentAllocations,
    ceilingSource,
  }
}

/**
 * Canonical input-snapshot hash.
 *
 * Two suggestions with the same hash MUST have the same weights — that is what
 * makes "did the recommendation change, or only my inputs?" answerable. So the
 * hash covers exactly the values the optimizer consumes, in a canonical form:
 * protocols sorted, numbers fixed to a stable precision (raw float
 * serialization would make the hash sensitive to noise far below what changes
 * an answer), and every constraint included.
 *
 * Follows the canonicalisation approach of normalizeStrategyConfig
 * (src/agent/effectiveStrategy.ts) and the `sha256:` prefix convention from
 * deriveTokenPrefix (src/middleware/adminAuth.ts).
 */
export function computeInputHash(input: {
  protocols: string[]
  expectedReturns: number[]
  covariance: number[][]
  riskTolerance: number
  effectiveRiskCeiling: number | undefined
  lookbackDays: number
}): string {
  // 9 decimal places: far finer than any difference that moves a weight, coarse
  // enough that float associativity noise cannot flip the hash.
  const round = (n: number): string => n.toFixed(9)

  const canonical = JSON.stringify({
    protocols: input.protocols,
    mu: input.expectedReturns.map(round),
    sigma: input.covariance.map((row) => row.map(round)),
    riskTolerance: input.riskTolerance,
    riskCeiling: input.effectiveRiskCeiling ?? null,
    lookbackDays: input.lookbackDays,
  })

  return 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex')
}

/**
 * Backtest both configurations over the same history.
 *
 * ─── WHAT THIS ACTUALLY SIMULATES ────────────────────────────────────────────
 *
 * The agent has NO multi-protocol position model: Position.protocolName is a
 * single string and TargetAllocationStrategy uses weights only to rank a single
 * hop (src/agent/strategies.ts). So this cannot and does not simulate holding a
 * weighted basket. It replays what the EXISTING agent would have done under each
 * weight vector, which is the honest question given the engine that exists.
 *
 * BACKTEST_CAVEAT travels with the result into the API response and the docs
 * rather than being left for a user to infer from a chart that looks like a
 * portfolio simulation.
 *
 * Returns null when there is nothing meaningful to compare.
 */
export async function computeBacktestComparison(
  suggestedPercentages: Record<string, number>,
  currentAllocations: Record<string, number> | undefined,
  rates: RawRateObservation[],
  riskCeiling: number | undefined,
  riskScores: Record<string, number>,
  userId: string,
  startingAmount: number,
  now: Date
): Promise<BacktestComparison | null> {
  if (Object.keys(suggestedPercentages).length === 0) return null

  const MS_PER_DAY = 24 * 60 * 60 * 1000
  const endDate = new Date(Math.floor(now.getTime() / MS_PER_DAY) * MS_PER_DAY)
  const startDate = new Date(
    endDate.getTime() - (DEFAULT_LOOKBACK_DAYS - 1) * MS_PER_DAY
  )

  const { series } = buildDailyRateSeries(rates, startDate, endDate)

  // Trim leading days that have no protocol at all.
  //
  // buildDailyRateSeries only carries a protocol forward from its first
  // observation, so if the earliest observation falls even minutes after the
  // window's opening midnight, day zero is empty — and runBacktest treats an
  // empty first day as `insufficient_history` and abandons the whole run. That
  // would discard 89 perfectly good days over a timestamp alignment artifact.
  // Trimming to the first populated day makes the comparison depend on the data
  // that exists rather than on when the rate scanner happened to run.
  const firstPopulated = series.findIndex((d) => d.protocols.length > 0)
  if (firstPopulated === -1) return null
  const trimmed = series.slice(firstPopulated)

  // The realized-APY denominator must match the window actually replayed.
  const effectiveStart = trimmed[0].date
  if (endDate.getTime() <= effectiveStart.getTime()) return null

  const strategy = new TargetAllocationStrategy()

  const runLeg = async (
    targetAllocations: Record<string, number>
  ): Promise<BacktestComparison['suggested'] | null> => {
    const outcome = await runBacktest(strategy, trimmed, {
      strategyName: 'TARGET_ALLOCATION',
      startDate: effectiveStart,
      endDate,
      startingAmount,
      userStrategyPreferences: [{ userId, targetAllocations }],
      riskCeiling,
      protocolRiskScores: riskScores,
    })
    if (outcome.status !== 'ok') return null
    return {
      finalValue: outcome.result.summary.finalValue,
      realizedApy: outcome.result.summary.realizedApy,
      maxDrawdownPercent: outcome.result.summary.maxDrawdownPercent,
      rebalanceCount: outcome.result.rebalanceEvents.length,
      finalProtocol: outcome.result.finalProtocol,
    }
  }

  const suggested = await runLeg(suggestedPercentages)
  if (!suggested) return null

  // A user with no allocation configured yet gets the suggested leg only —
  // there is no "current" to compare against, and inventing one would be a
  // fabricated baseline.
  const current =
    currentAllocations && Object.keys(currentAllocations).length > 0
      ? await runLeg(currentAllocations)
      : null

  return {
    suggested,
    current,
    startDate: effectiveStart.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
    startingAmount,
    caveat: BACKTEST_CAVEAT,
  }
}

/**
 * Compute (and persist) an allocation suggestion for one user.
 *
 * @param userId  The user the suggestion is for.
 * @param options.now         Reference "now", injected for deterministic tests.
 * @param options.persist     Set false to compute without writing a row.
 * @param options.runBacktest Set false to skip the backtest legs (the job does
 *                            this — the comparison is the expensive part and is
 *                            only interesting when a human is looking).
 */
export async function suggestAllocation(
  userId: string,
  options: {
    now?: Date
    persist?: boolean
    runBacktest?: boolean
    lookbackDays?: number
    /** Efficient-frontier resolution. Clamped by the optimizer's hard cap. */
    frontierPoints?: number
  } = {}
): Promise<AllocationSuggestionResult> {
  const now = options.now ?? new Date()
  const persist = options.persist ?? true
  const wantBacktest = options.runBacktest ?? true
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, riskTolerance: true, strategyConfig: true },
  })
  if (!user) throw new SuggestionUserNotFoundError(userId)

  const [follow, goal] = await Promise.all([
    db.strategyFollow.findFirst({
      where: { followerUserId: userId, unfollowedAt: null },
      select: { appliedConfig: true },
    }),
    db.savingsGoal.findFirst({
      where: { userId, status: 'ACTIVE' },
      select: { riskCeiling: true },
    }),
  ])

  const effective = resolveEffectiveInputs(
    user.riskTolerance,
    user.strategyConfig,
    follow?.appliedConfig ?? null,
    goal?.riskCeiling ?? null
  )

  const MS_PER_DAY = 24 * 60 * 60 * 1000
  const since = new Date(now.getTime() - lookbackDays * MS_PER_DAY)

  const [rateRows, scoreRows] = await Promise.all([
    db.protocolRate.findMany({
      where: { fetchedAt: { gte: since } },
      select: {
        protocolName: true,
        assetSymbol: true,
        supplyApy: true,
        fetchedAt: true,
      },
    }),
    db.protocolRiskScore.findMany({
      select: {
        protocolName: true,
        score: true,
        insufficientHistory: true,
      },
    }),
  ])

  const rates: RawRateObservation[] = rateRows.map((r) => ({
    protocolName: r.protocolName,
    assetSymbol: r.assetSymbol,
    apy: Number(r.supplyApy),
    date: r.fetchedAt,
  }))
  const riskScores: RiskScoreRow[] = scoreRows.map((s) => ({
    protocolName: s.protocolName,
    score: s.score,
    insufficientHistory: s.insufficientHistory,
  }))

  const estimation = estimate({
    rates,
    riskScores,
    lookbackDays,
    riskCeiling: effective.effectiveRiskCeiling,
    now,
  })

  const outcome = optimize(
    {
      protocols: estimation.protocols,
      expectedReturns: estimation.expectedReturns,
      covariance: estimation.covariance,
      riskTolerance: effective.riskTolerance,
      riskScores: estimation.riskScores,
      frontierPoints: options.frontierPoints,
    },
    estimation.excluded
  )

  const inputHash = computeInputHash({
    protocols: estimation.protocols,
    expectedReturns: estimation.expectedReturns,
    covariance: estimation.covariance,
    riskTolerance: effective.riskTolerance,
    effectiveRiskCeiling: effective.effectiveRiskCeiling,
    lookbackDays,
  })

  const weights =
    outcome.status === 'ok'
      ? toPercentageAllocations(outcome.weights)
      : outcome.status === 'non_converged'
        ? toPercentageAllocations(outcome.bestFeasibleWeights)
        : {}

  let backtest: BacktestComparison | null = null
  if (wantBacktest && Object.keys(weights).length > 0) {
    const startingAmount = await resolveNotional(userId)
    backtest = await computeBacktestComparison(
      weights,
      effective.currentAllocations,
      rates,
      effective.effectiveRiskCeiling,
      estimation.riskScores,
      userId,
      startingAmount,
      now
    )
  }

  const result: AllocationSuggestionResult = {
    isSuggestion: true,
    disclaimer: ADVISORY_DISCLAIMER,
    userId,
    inputHash,
    status: outcome.status,
    weights,
    outcome,
    riskTolerance: effective.riskTolerance,
    effectiveRiskCeiling: effective.effectiveRiskCeiling ?? null,
    ceilingSource: effective.ceilingSource,
    currentAllocations: effective.currentAllocations ?? null,
    excluded: estimation.excluded,
    observationCount: estimation.observationCount,
    lookbackDays,
    backtest,
    computedAt: now.toISOString(),
  }

  if (persist) {
    const row = await db.allocationSuggestion.create({
      data: {
        userId,
        inputHash,
        status: outcome.status,
        weights,
        // Prisma's InputJsonValue does not accept a typed interface array
        // directly (no index signature); these are plain JSON-safe structures.
        frontier: (outcome.status === 'ok'
          ? outcome.frontier
          : []) as unknown as Prisma.InputJsonValue,
        backtestSummary: backtest
          ? (backtest as unknown as Prisma.InputJsonValue)
          : undefined,
        riskTolerance: effective.riskTolerance,
        effectiveRiskCeiling: effective.effectiveRiskCeiling ?? null,
        reason: describeOutcome(outcome),
        computedAt: now,
      },
      select: { id: true },
    })
    result.id = row.id
  }

  logger.info('[Analytics] Allocation suggestion computed', {
    userId,
    status: outcome.status,
    inputHash,
    eligibleProtocols: estimation.protocols.length,
    excludedCount: estimation.excluded.length,
    riskCeiling: effective.effectiveRiskCeiling ?? null,
    ceilingSource: effective.ceilingSource,
    persisted: persist,
  })

  return result
}

/**
 * The user's current invested value, used as the backtest's starting capital so
 * the comparison is denominated in numbers they recognize. Falls back to a fixed
 * notional when they hold nothing — the comparison is relative, and a fixed
 * fallback keeps the run deterministic.
 */
async function resolveNotional(userId: string): Promise<number> {
  const positions = await db.position.findMany({
    where: { userId, status: 'ACTIVE' },
    select: { currentValue: true },
  })
  const total = positions.reduce((s, p) => s + Number(p.currentValue), 0)
  return total > 0 ? total : DEFAULT_BACKTEST_NOTIONAL
}

/** One-line human explanation of a non-ok outcome, stored on the row. */
function describeOutcome(outcome: OptimizationOutcome): string | null {
  switch (outcome.status) {
    case 'ok':
      return null
    case 'infeasible':
      return `${outcome.reason} (binding constraint: ${outcome.bindingConstraint})`
    case 'insufficient_universe':
      return `Only ${outcome.eligibleCount} protocol(s) eligible; at least 2 are required${
        outcome.bindingConstraint
          ? ` (binding constraint: ${outcome.bindingConstraint})`
          : ''
      }`
    case 'non_converged':
      return `Solver did not converge within ${outcome.iterations} iterations (residual ${outcome.residual.toExponential(3)}); returning the best feasible allocation found`
  }
}
