/**
 * src/routes/analytics.ts
 *
 * Analytics API routes.
 *
 * Existing routes (APY history, user yield, protocol performance) are
 * unchanged. New risk endpoints delegate to src/analytics/service.ts —
 * there is exactly one implementation of VaR/CVaR/Sortino in this codebase.
 *
 * Security
 * ─────────
 * GET /risk and GET /risk/timeseries require JWT authentication and
 * enforce ownership: the userId is taken from req.auth (the verified JWT
 * payload), never from a caller-supplied path parameter.
 */

import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { AuthMiddleware } from '../middleware/authenticate'
import { getPortfolioRisk, getPortfolioTimeseries, getPersistedUserRisk, type RiskWindow } from '../analytics/service'

const router = Router()

const periodSchema = z.object({
  period: z.enum(['7d', '30d', '90d']).default('30d'),
})

const riskWindowSchema = z.object({
  window: z.enum(['7d', '30d', '90d']).default('30d'),
})

const timeseriesSchema = z.object({
  window: z.enum(['7d', '30d', '90d']).default('30d'),
  rollingWindow: z.coerce.number().int().min(2).max(30).default(7),
})

function periodToDays(period: string): number {
  return period === '7d' ? 7 : period === '30d' ? 30 : 90
}

/**
 * GET /analytics/apy-history
 * Returns APY snapshots over time for a user's positions (graph-ready).
 */
router.get('/apy-history', AuthMiddleware.validateJwt, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = periodSchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const fromDate = new Date(Date.now() - periodToDays(parsed.data.period) * 86400_000)

  const snapshots = await db.yieldSnapshot.findMany({
    where: { position: { userId }, snapshotAt: { gte: fromDate } },
    orderBy: { snapshotAt: 'asc' },
    select: { snapshotAt: true, apy: true, positionId: true },
  })

  const points = snapshots.map((s) => ({
    date: s.snapshotAt.toISOString().slice(0, 10),
    apy: Number(s.apy),
    positionId: s.positionId,
  }))

  return res.status(200).json({ userId, period: parsed.data.period, points })
})

/**
 * GET /analytics/user-yield
 * Returns cumulative and period yield earned by the authenticated user.
 */
router.get('/user-yield', AuthMiddleware.validateJwt, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = periodSchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const fromDate = new Date(Date.now() - periodToDays(parsed.data.period) * 86400_000)

  const [positions, snapshots] = await Promise.all([
    db.position.findMany({ where: { userId }, select: { yieldEarned: true, assetSymbol: true } }),
    db.yieldSnapshot.findMany({
      where: { position: { userId }, snapshotAt: { gte: fromDate } },
      orderBy: { snapshotAt: 'asc' },
      select: { snapshotAt: true, yieldAmount: true, apy: true },
    }),
  ])

  const totalYield = positions.reduce((sum, p) => sum + Number(p.yieldEarned), 0)
  const periodYield = snapshots.reduce((sum, s) => sum + Number(s.yieldAmount), 0)
  const averageApy =
    snapshots.length > 0
      ? snapshots.reduce((sum, s) => sum + Number(s.apy), 0) / snapshots.length
      : 0

  const points = snapshots.map((s) => ({
    date: s.snapshotAt.toISOString().slice(0, 10),
    yieldAmount: Number(s.yieldAmount),
    apy: Number(s.apy),
  }))

  return res.status(200).json({
    userId,
    period: parsed.data.period,
    totalYield,
    periodYield,
    averageApy,
    points,
  })
})

/**
 * GET /analytics/protocol-performance
 * Returns historical APY rates per protocol (graph-ready).
 */
router.get('/protocol-performance', async (req: Request, res: Response) => {
  const parsed = periodSchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const fromDate = new Date(Date.now() - periodToDays(parsed.data.period) * 86400_000)

  const rates = await db.protocolRate.findMany({
    where: { fetchedAt: { gte: fromDate } },
    orderBy: { fetchedAt: 'asc' },
    select: {
      protocolName: true,
      assetSymbol: true,
      supplyApy: true,
      tvl: true,
      fetchedAt: true,
      network: true,
    },
  })

  // Group by protocol for graph-ready output
  const byProtocol: Record<string, { protocol: string; asset: string; network: string; points: { date: string; apy: number; tvl: number | null }[] }> = {}

  for (const r of rates) {
    const key = `${r.protocolName}:${r.assetSymbol}:${r.network}`
    if (!byProtocol[key]) {
      byProtocol[key] = { protocol: r.protocolName, asset: r.assetSymbol, network: r.network, points: [] }
    }
    byProtocol[key].points.push({
      date: r.fetchedAt.toISOString().slice(0, 10),
      apy: Number(r.supplyApy),
      tvl: r.tvl !== null ? Number(r.tvl) : null,
    })
  }

  return res.status(200).json({ period: parsed.data.period, protocols: Object.values(byProtocol) })
})

/**
 * GET /api/v1/analytics/risk
 *
 * Returns precomputed (or freshly computed) risk metrics for the authenticated
 * user's portfolio:
 *   - VaR 95%/99% (historical and parametric)
 *   - CVaR 95%/99% (historical)
 *   - Sortino ratio
 *   - Downside deviation
 *   - Max drawdown + duration
 *   - Annualised volatility
 *   - Sample count + exact data window
 *   - Insufficient-history flag
 *   - computedAt timestamp (staleness signal)
 *
 * Query params:
 *   window  '7d' | '30d' | '90d'  (default: '30d')
 *
 * If a precomputed row exists and is recent (< 1h old), it is returned
 * directly from the DB to avoid per-request recompute. Otherwise a live
 * compute is performed.
 *
 * Ownership: userId is taken from req.auth.userId (JWT), never a path param.
 */
router.get('/risk', AuthMiddleware.validateJwt, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = riskWindowSchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const window = parsed.data.window as RiskWindow

  try {
    // Try to serve a cached aggregate (< 1 hour old)
    const cached = await getPersistedUserRisk(userId, window)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)

    if (cached && cached.computedAt > oneHourAgo) {
      return res.status(200).json({
        userId,
        requestedWindow: window,
        actualWindowDays: cached.dataFrom && cached.dataTo
          ? Math.ceil((new Date(cached.dataTo).getTime() - new Date(cached.dataFrom).getTime()) / 86400_000)
          : 0,
        insufficientHistory: cached.insufficientHistory,
        dataFrom: cached.dataFrom?.toISOString() ?? null,
        dataTo: cached.dataTo?.toISOString() ?? null,
        computedAt: cached.computedAt.toISOString(),
        source: 'precomputed',
        metrics: cached.sampleCount === 0 ? null : {
          sampleCount: cached.sampleCount,
          annualisedVolatility: cached.annualisedVolatility !== null ? Number(cached.annualisedVolatility) : null,
          sortinoRatio: cached.sortinoRatio !== null ? Number(cached.sortinoRatio) : null,
          downsideDeviation: cached.downsideDeviation !== null ? Number(cached.downsideDeviation) : null,
          maxDrawdown: cached.maxDrawdown !== null ? Number(cached.maxDrawdown) : null,
          maxDrawdownDuration: cached.maxDrawdownDuration,
          varHistorical95: cached.varHistorical95 !== null ? Number(cached.varHistorical95) : null,
          varHistorical99: cached.varHistorical99 !== null ? Number(cached.varHistorical99) : null,
          varParametric95: cached.varParametric95 !== null ? Number(cached.varParametric95) : null,
          varParametric99: cached.varParametric99 !== null ? Number(cached.varParametric99) : null,
          cvarHistorical95: cached.cvarHistorical95 !== null ? Number(cached.cvarHistorical95) : null,
          cvarHistorical99: cached.cvarHistorical99 !== null ? Number(cached.cvarHistorical99) : null,
          beta: cached.beta !== null ? Number(cached.beta) : null,
        },
      })
    }

    // Live compute
    const result = await getPortfolioRisk(userId, window)

    return res.status(200).json({
      ...result,
      source: 'live',
    })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to compute risk metrics' })
  }
})

/**
 * GET /api/v1/analytics/risk/timeseries
 *
 * Returns graph-ready rolling volatility and drawdown series for the
 * authenticated user's portfolio.
 *
 * Query params:
 *   window         '7d' | '30d' | '90d'  (default: '30d')
 *   rollingWindow  integer 2-30           (default: 7 — observations per rolling vol window)
 *
 * Ownership: userId taken from JWT, never a path param.
 */
router.get('/risk/timeseries', AuthMiddleware.validateJwt, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = timeseriesSchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  try {
    const result = await getPortfolioTimeseries(
      userId,
      parsed.data.window as RiskWindow,
      parsed.data.rollingWindow
    )
    return res.status(200).json(result)
  } catch (err) {
    return res.status(500).json({ error: 'Failed to compute timeseries' })
  }
})

export default router
