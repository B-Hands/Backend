/**
 * src/analytics/service.ts
 *
 * Database I/O layer for the portfolio risk analytics engine.
 *
 * CONTRACT
 * ─────────
 * • This is the ONLY file that reads YieldSnapshot rows to build value series.
 * • Enforces the 90-day retention bound: windows longer than the available
 *   data are relabelled with `insufficientHistory: true` — they are NEVER
 *   silently served under the requested label.
 * • Aggregates portfolio value as sum(principalAmount + yieldAmount) across
 *   all YieldSnapshot rows sharing an exact snapshotAt for a given userId.
 * • User-scoped queries are strictly user-scoped end-to-end.
 */

import db from '../db'
import { logger } from '../utils/logger'
import {
  computeAllMetrics,
  computePeriodReturns,
  inferPeriodsPerYear,
  rollingVolatility,
  rollingDrawdown,
  type ValuePoint,
  type RiskMetrics,
  type RollingVolPoint,
  type RollingDrawdownPoint,
} from './metrics'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hard-delete boundary in snapshotter.ts — we cannot honestly serve beyond this. */
export const SNAPSHOT_RETENTION_DAYS = 90

/** Valid request windows. */
export type RiskWindow = '7d' | '30d' | '90d'

export function windowToDays(w: RiskWindow): number {
  return w === '7d' ? 7 : w === '30d' ? 30 : 90
}

// ─── Return types ─────────────────────────────────────────────────────────────

export interface PortfolioRiskResult {
  userId: string
  requestedWindow: RiskWindow
  /** Actual data window used — may be shorter than requested. */
  actualWindowDays: number
  /** True if the available history is shorter than the requested window. */
  insufficientHistory: boolean
  /** ISO timestamp of earliest snapshot included. */
  dataFrom: string | null
  /** ISO timestamp of latest snapshot included. */
  dataTo: string | null
  metrics: RiskMetrics | null
  computedAt: string
}

export interface TimeseriesResult {
  userId: string
  requestedWindow: RiskWindow
  insufficientHistory: boolean
  rollingVolatility: RollingVolPoint[]
  drawdown: RollingDrawdownPoint[]
  computedAt: string
}

// ─── Portfolio value series builder ──────────────────────────────────────────

/**
 * Build a portfolio-value series for a user over a date window.
 *
 * Aggregation: for each unique snapshotAt timestamp, sum
 * (principalAmount + yieldAmount) across all positions belonging to the user.
 * This is the "correct input series" documented in the issue — not raw APY.
 *
 * Positions must belong to userId — query is scoped via the Position relation.
 */
async function buildUserValueSeries(
  userId: string,
  fromDate: Date,
  toDate: Date
): Promise<ValuePoint[]> {
  const snapshots = await db.yieldSnapshot.findMany({
    where: {
      position: { userId },
      snapshotAt: { gte: fromDate, lte: toDate },
    },
    select: {
      snapshotAt: true,
      principalAmount: true,
      yieldAmount: true,
    },
    orderBy: { snapshotAt: 'asc' },
  })

  // Bucket by exact snapshotAt (epoch ms) and sum values
  const buckets = new Map<number, number>()
  for (const s of snapshots) {
    const key = s.snapshotAt.getTime()
    const value =
      Number(s.principalAmount) + Number(s.yieldAmount)
    buckets.set(key, (buckets.get(key) ?? 0) + value)
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([timestampMs, value]) => ({ timestampMs, value }))
}

// ─── Retention-bound check ────────────────────────────────────────────────────

/**
 * Determine whether the requested window exceeds available retention.
 * Returns the honest available span in days (capped at SNAPSHOT_RETENTION_DAYS).
 */
function resolveWindow(
  requestedWindow: RiskWindow,
  oldestSnapshotDate: Date | null,
  now: Date
): { actualDays: number; insufficientHistory: boolean } {
  const requestedDays = windowToDays(requestedWindow)
  const maxDays = SNAPSHOT_RETENTION_DAYS

  if (!oldestSnapshotDate) {
    return { actualDays: 0, insufficientHistory: true }
  }

  const availableDays = Math.ceil(
    (now.getTime() - oldestSnapshotDate.getTime()) / (24 * 60 * 60 * 1000)
  )

  const actualDays = Math.min(requestedDays, availableDays, maxDays)
  const insufficientHistory = availableDays < requestedDays

  return { actualDays, insufficientHistory }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute portfolio risk metrics for a user.
 *
 * @param userId - Authenticated user's ID (ownership is enforced by the caller).
 * @param window - Requested analysis window.
 */
export async function getPortfolioRisk(
  userId: string,
  window: RiskWindow
): Promise<PortfolioRiskResult> {
  const computedAt = new Date().toISOString()
  const now = new Date()

  try {
    // Find the oldest snapshot to determine available history
    const oldestSnapshot = await db.yieldSnapshot.findFirst({
      where: { position: { userId } },
      orderBy: { snapshotAt: 'asc' },
      select: { snapshotAt: true },
    })

    const { actualDays, insufficientHistory } = resolveWindow(
      window,
      oldestSnapshot?.snapshotAt ?? null,
      now
    )

    const fromDate = new Date(now.getTime() - actualDays * 24 * 60 * 60 * 1000)

    const series = await buildUserValueSeries(userId, fromDate, now)

    const metrics = computeAllMetrics(series)

    return {
      userId,
      requestedWindow: window,
      actualWindowDays: actualDays,
      insufficientHistory,
      dataFrom: series[0]
        ? new Date(series[0].timestampMs).toISOString()
        : null,
      dataTo: series[series.length - 1]
        ? new Date(series[series.length - 1]!.timestampMs).toISOString()
        : null,
      metrics,
      computedAt,
    }
  } catch (error) {
    logger.error('[Analytics] getPortfolioRisk failed', {
      userId,
      window,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Get timeseries data (rolling volatility + drawdown) for a user.
 *
 * @param userId - Authenticated user's ID.
 * @param window - Requested analysis window.
 * @param rollingWindowSize - Number of observations per rolling window (default 7).
 */
export async function getPortfolioTimeseries(
  userId: string,
  window: RiskWindow,
  rollingWindowSize = 7
): Promise<TimeseriesResult> {
  const now = new Date()

  const oldestSnapshot = await db.yieldSnapshot.findFirst({
    where: { position: { userId } },
    orderBy: { snapshotAt: 'asc' },
    select: { snapshotAt: true },
  })

  const { actualDays, insufficientHistory } = resolveWindow(
    window,
    oldestSnapshot?.snapshotAt ?? null,
    now
  )

  const fromDate = new Date(now.getTime() - actualDays * 24 * 60 * 60 * 1000)
  const series = await buildUserValueSeries(userId, fromDate, now)

  if (series.length < 2) {
    return {
      userId,
      requestedWindow: window,
      insufficientHistory: true,
      rollingVolatility: [],
      drawdown: [],
      computedAt: now.toISOString(),
    }
  }

  const periodsPerYear = inferPeriodsPerYear(series) ?? 365
  const returns = computePeriodReturns(series)
  // Timestamps for rolling vol correspond to end-of-period (index i+1 in sorted series)
  const returnTimestamps = series.slice(1).map((p) => p.timestampMs)

  const volSeries = rollingVolatility(returns, returnTimestamps, rollingWindowSize, periodsPerYear)
  const drawdownSeries = rollingDrawdown(series)

  return {
    userId,
    requestedWindow: window,
    insufficientHistory,
    rollingVolatility: volSeries,
    drawdown: drawdownSeries,
    computedAt: now.toISOString(),
  }
}

/**
 * Compute risk metrics for a published strategy.
 *
 * Security & Privacy:
 * Derived from the strategy's own snapshots/positions — returns only relative risk
 * statistics (volatility, Sortino, VaR, drawdown), NEVER absolute currency values,
 * user IDs, or wallet addresses.
 *
 * @param publishedStrategyId - Identifier for the published strategy or protocol.
 * @param window - Requested analysis window.
 */
export async function getStrategyRiskMetrics(
  publishedStrategyId: string,
  window: RiskWindow
): Promise<{
  publishedStrategyId: string
  requestedWindow: RiskWindow
  insufficientHistory: boolean
  metrics: RiskMetrics | null
  computedAt: string
}> {
  const now = new Date()

  // Find snapshots associated with positions matching this strategy/protocol
  const oldestSnapshot = await db.yieldSnapshot.findFirst({
    where: {
      OR: [
        { positionId: publishedStrategyId },
        { position: { protocolName: publishedStrategyId } },
      ],
    },
    orderBy: { snapshotAt: 'asc' },
    select: { snapshotAt: true },
  })

  const { actualDays, insufficientHistory } = resolveWindow(
    window,
    oldestSnapshot?.snapshotAt ?? null,
    now
  )

  const fromDate = new Date(now.getTime() - actualDays * 24 * 60 * 60 * 1000)

  const snapshots = await db.yieldSnapshot.findMany({
    where: {
      OR: [
        { positionId: publishedStrategyId },
        { position: { protocolName: publishedStrategyId } },
      ],
      snapshotAt: { gte: fromDate, lte: now },
    },
    select: {
      snapshotAt: true,
      principalAmount: true,
      yieldAmount: true,
    },
    orderBy: { snapshotAt: 'asc' },
  })

  const buckets = new Map<number, number>()
  for (const s of snapshots) {
    const key = s.snapshotAt.getTime()
    const val = Number(s.principalAmount) + Number(s.yieldAmount)
    buckets.set(key, (buckets.get(key) ?? 0) + val)
  }

  const series: ValuePoint[] = Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([timestampMs, value]) => ({ timestampMs, value }))

  const metrics = computeAllMetrics(series)

  return {
    publishedStrategyId,
    requestedWindow: window,
    insufficientHistory,
    metrics,
    computedAt: now.toISOString(),
  }
}

// ─── Persisted aggregate helpers ─────────────────────────────────────────────

/**
 * Fetch a precomputed risk aggregate for a user from the DB.
 * Used by the API routes to serve cached results without per-request compute.
 */
export async function getPersistedUserRisk(
  userId: string,
  window: RiskWindow
): Promise<any | null> {
  return db.portfolioRiskAggregate.findFirst({
    where: { userId, window },
    orderBy: { computedAt: 'desc' },
  })
}

/**
 * Upsert a precomputed risk aggregate for a user.
 * Called by the portfolioRisk scheduled job.
 */
export async function upsertUserRiskAggregate(
  userId: string,
  window: RiskWindow,
  data: {
    insufficientHistory: boolean
    sampleCount: number
    annualisedVolatility: number | null
    sortinoRatio: number | null
    downsideDeviation: number | null
    maxDrawdown: number | null
    maxDrawdownDuration: number | null
    varHistorical95: number | null
    varHistorical99: number | null
    varParametric95: number | null
    varParametric99: number | null
    cvarHistorical95: number | null
    cvarHistorical99: number | null
    beta: number | null
    dataFrom: Date | null
    dataTo: Date | null
  }
): Promise<void> {
  await db.portfolioRiskAggregate.upsert({
    where: { userId_window: { userId, window } },
    update: {
      ...data,
      computedAt: new Date(),
    },
    create: {
      userId,
      window,
      ...data,
      computedAt: new Date(),
    },
  })
}
