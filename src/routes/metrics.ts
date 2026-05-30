import { Router, Request, Response } from 'express'
import { getMetrics } from '../utils/metrics'

const router = Router()

/**
 * GET /metrics
 * Prometheus-compatible metrics endpoint for observability
 *
 * Exposes all registered metrics in Prometheus format for scraping by
 * Prometheus, Grafana, or other monitoring systems.
 *
 * Metrics include:
 * - Event processing counters and histograms
 * - Failure metrics
 * - DLQ size
 * - Cursor lag
 * - Agent loop heartbeat
 * - Database operation metrics
 * - HTTP request metrics
 * - Analytics API metrics
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const metrics = await getMetrics()
    res.set('Content-Type', 'text/plain')
    res.status(200).send(metrics)
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve metrics' })
  }
})

export default router
