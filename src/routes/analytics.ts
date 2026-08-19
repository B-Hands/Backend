import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { requireAuth } from '../middleware/authenticate'
import { mapPortfolioAttributionToResponse } from '../utils/api-formatters'

const router = Router()

const periodSchema = z.object({
  period: z.enum(['7d', '30d', '90d']).default('30d'),
})

function periodToDays(period: string): number {
  return period === '7d' ? 7 : period === '30d' ? 30 : 90
}

/**
 * `window` accepts 30d/90d only, same retention-honest rule as the strategy
 * marketplace (src/validators/strategy-validators.ts): YieldSnapshot rows are
 * hard-deleted past 90 days (src/agent/snapshotter.ts), so a longer window
 * has no data behind it.
 */
const attributionQuerySchema = z.object({
  window: z
    .enum(['30d', '90d'], {
      error:
        'window must be "30d" or "90d". Longer windows are unavailable because yield snapshots are retained for 90 days.',
    })
    .default('30d'),
})

function attributionWindowToDays(window: '30d' | '90d'): number {
  return window === '30d' ? 30 : 90
}

/**
 * GET /analytics/apy-history
 * Returns APY snapshots over time for a user's positions (graph-ready).
 */
router.get('/apy-history', requireAuth, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = periodSchema.safeParse(req.query)
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const fromDate = new Date(
    Date.now() - periodToDays(parsed.data.period) * 86400_000
  )

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
router.get('/user-yield', requireAuth, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = periodSchema.safeParse(req.query)
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const fromDate = new Date(
    Date.now() - periodToDays(parsed.data.period) * 86400_000
  )

  const [positions, snapshots] = await Promise.all([
    db.position.findMany({
      where: { userId },
      select: { yieldEarned: true, assetSymbol: true },
    }),
    db.yieldSnapshot.findMany({
      where: { position: { userId }, snapshotAt: { gte: fromDate } },
      orderBy: { snapshotAt: 'asc' },
      select: { snapshotAt: true, yieldAmount: true, apy: true },
    }),
  ])

  const totalYield = positions.reduce(
    (sum, p) => sum + Number(p.yieldEarned),
    0
  )
  const periodYield = snapshots.reduce(
    (sum, s) => sum + Number(s.yieldAmount),
    0
  )
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
    return res
      .status(400)
      .json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const fromDate = new Date(
    Date.now() - periodToDays(parsed.data.period) * 86400_000
  )

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
  const byProtocol: Record<
    string,
    {
      protocol: string
      asset: string
      network: string
      points: { date: string; apy: number; tvl: number | null }[]
    }
  > = {}

  for (const r of rates) {
    const key = `${r.protocolName}:${r.assetSymbol}:${r.network}`
    if (!byProtocol[key]) {
      byProtocol[key] = {
        protocol: r.protocolName,
        asset: r.assetSymbol,
        network: r.network,
        points: [],
      }
    }
    byProtocol[key].points.push({
      date: r.fetchedAt.toISOString().slice(0, 10),
      apy: Number(r.supplyApy),
      tvl: r.tvl !== null ? Number(r.tvl) : null,
    })
  }

  return res
    .status(200)
    .json({ period: parsed.data.period, protocols: Object.values(byProtocol) })
})

/**
 * GET /analytics/attribution
 *
 * Benchmark-relative Brinson attribution for the caller's OWN portfolio —
 * owner-scoped via req.auth.userId, never a path param (#320). Reads the
 * precomputed PortfolioAttribution row rather than recomputing per request;
 * see src/jobs/attribution.ts and src/analytics/attribution.ts.
 *
 * A 200 with `computed: false` (not a 404) is returned when nothing has been
 * precomputed yet for this user/window — "no attribution yet" is a normal
 * state for a very new account, not a missing resource, mirroring the
 * `{ follow: null }` convention in the strategy marketplace.
 */
router.get('/attribution', requireAuth, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = attributionQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const windowDays = attributionWindowToDays(parsed.data.window)

  const row = await db.portfolioAttribution.findUnique({
    where: { userId_windowDays: { userId, windowDays } },
  })

  if (!row) {
    return res.status(200).json({
      userId,
      window: parsed.data.window,
      computed: false,
    })
  }

  return res.status(200).json({
    userId,
    window: parsed.data.window,
    computed: true,
    ...mapPortfolioAttributionToResponse(row),
  })
})

export default router
