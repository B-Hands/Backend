import request from 'supertest'

import db from '../../src/db'
import app from '../../src'

declare const jest: any
declare const describe: any
declare const it: any
declare const beforeEach: any
declare const expect: any

// --- Mocks ---

jest.mock('../../src/stellar/events', () => ({
  __esModule: true,
  startEventListener: jest.fn().mockResolvedValue(undefined),
  stopEventListener: jest.fn(),
}))

jest.mock('../../src/stellar/contract', () => ({
  __esModule: true,
  depositForUser: jest.fn().mockResolvedValue({
    hash: `mock-tx-${Date.now()}`,
    status: 'success',
  }),
  withdrawForUser: jest.fn(),
}))

jest.mock('../../src/utils/metrics', () => ({
  updateDlqSize: jest.fn(),
  updateCursorLag: jest.fn(),
  updateLastProcessedLedger: jest.fn(),
  recordDbOperation: jest.fn(),
  recordEventDuration: jest.fn(),
  recordEventFailed: jest.fn(),
  recordEventProcessed: jest.fn(),
  recordBackgroundJob: jest.fn(),
}))

jest.mock('../../src/services/alerting', () => ({
  alertingService: {
    emitDLQAlert: jest.fn(),
    clearDLQAlertState: jest.fn(),
  },
}))

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
}))

jest.mock('../../src/services/webhookDispatcher', () => ({
  dispatchWebhookEvent: jest.fn().mockResolvedValue(undefined),
}))

// --- Helpers ---

function uuid(): string {
  return `t-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function randomToken(): string {
  return `it-token-${uuid()}`
}

async function seedUser(): Promise<{
  userId: string
  walletAddress: string
  sessionToken: string
}> {
  const userId = `it-user-${uuid()}`
  const walletAddress =
    `G${uuid().replace(/-/g, '').slice(0, 47)}WALLETADDR`.slice(0, 56)

  const user = await db.user.create({
    data: {
      walletAddress,
      network: 'TESTNET',
      displayName: 'IT Test',
      email: `it-${Date.now()}-${Math.random()}@example.com`,
      riskTolerance: 5,
      isActive: true,
    },
  })

  const sessionToken = randomToken()
  await db.session.create({
    data: {
      userId: user.id,
      token: sessionToken,
      walletAddress: user.walletAddress,
      network: user.network,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      ipAddress: '127.0.0.1',
      userAgent: 'recurring-deposit-e2e-tests',
    },
  })

  return { userId: user.id, walletAddress, sessionToken }
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` }
}

describe('E2E integration — recurring deposits', () => {
  beforeEach(async () => {
    jest.clearAllMocks()
  })

  it('POST /api/deposit/recurring → creates plan, GET lists it, DELETE cancels it', async () => {
    const { userId, sessionToken } = await seedUser()

    // Create
    const createRes = await request(app)
      .post('/api/v1/deposit/recurring')
      .set(authHeaders(sessionToken))
      .send({
        userId,
        amount: 50,
        assetSymbol: 'USDC',
        cadence: 'WEEKLY',
        confirmed: true,
      })

    expect(createRes.status).toBe(201)
    expect(createRes.body.plan).toBeDefined()
    expect(createRes.body.plan.userId).toBe(userId)
    expect(createRes.body.plan.amount).toBe('50')
    expect(createRes.body.plan.cadence).toBe('WEEKLY')
    expect(createRes.body.plan.status).toBe('ACTIVE')
    expect(createRes.body.plan.nextRunAt).toBeDefined()

    const planId = createRes.body.plan.id

    // List
    const listRes = await request(app)
      .get(`/api/v1/deposit/recurring/by-user/${userId}`)
      .set(authHeaders(sessionToken))

    expect(listRes.status).toBe(200)
    expect(listRes.body.plans).toHaveLength(1)
    expect(listRes.body.plans[0].id).toBe(planId)

    // Cancel
    const deleteRes = await request(app)
      .delete(`/api/v1/deposit/recurring/${planId}`)
      .set(authHeaders(sessionToken))

    expect(deleteRes.status).toBe(200)
    expect(deleteRes.body.plan.status).toBe('CANCELLED')
  })

  it('PATCH /api/deposit/recurring/:id — pauses and resumes a plan', async () => {
    const { userId, sessionToken } = await seedUser()

    const createRes = await request(app)
      .post('/api/v1/deposit/recurring')
      .set(authHeaders(sessionToken))
      .send({
        userId,
        amount: 100,
        assetSymbol: 'USDC',
        cadence: 'MONTHLY',
        confirmed: true,
      })

    const planId = createRes.body.plan.id

    // Pause
    const pauseRes = await request(app)
      .patch(`/api/v1/deposit/recurring/${planId}`)
      .set(authHeaders(sessionToken))
      .send({ status: 'PAUSED' })

    expect(pauseRes.status).toBe(200)
    expect(pauseRes.body.plan.status).toBe('PAUSED')

    // Resume
    const resumeRes = await request(app)
      .patch(`/api/v1/deposit/recurring/${planId}`)
      .set(authHeaders(sessionToken))
      .send({ status: 'ACTIVE' })

    expect(resumeRes.status).toBe(200)
    expect(resumeRes.body.plan.status).toBe('ACTIVE')
  })

  it('ownership check: user B cannot modify user A plan', async () => {
    const userA = await seedUser()
    const userB = await seedUser()

    const createRes = await request(app)
      .post('/api/v1/deposit/recurring')
      .set(authHeaders(userA.sessionToken))
      .send({
        userId: userA.userId,
        amount: 50,
        assetSymbol: 'USDC',
        cadence: 'WEEKLY',
        confirmed: true,
      })

    const planId = createRes.body.plan.id

    // User B tries to pause user A's plan
    const patchRes = await request(app)
      .patch(`/api/v1/deposit/recurring/${planId}`)
      .set(authHeaders(userB.sessionToken))
      .send({ status: 'PAUSED' })

    expect(patchRes.status).toBe(401)

    // User B tries to cancel user A's plan
    const deleteRes = await request(app)
      .delete(`/api/v1/deposit/recurring/${planId}`)
      .set(authHeaders(userB.sessionToken))

    expect(deleteRes.status).toBe(401)
  })

  it('creation rejects when confirmed is not true', async () => {
    const { userId, sessionToken } = await seedUser()

    const res = await request(app)
      .post('/api/v1/deposit/recurring')
      .set(authHeaders(sessionToken))
      .send({
        userId,
        amount: 50,
        assetSymbol: 'USDC',
        cadence: 'WEEKLY',
        confirmed: false,
      })

    expect(res.status).toBe(400)
  })
})
