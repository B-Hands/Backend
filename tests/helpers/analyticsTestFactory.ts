/**
 * Analytics Test Factory
 *
 * Provides reusable test data factories and helpers for analytics API integration tests.
 * Ensures consistent test data setup and cleanup across all analytics endpoint tests.
 */

import { PrismaClient } from '@prisma/client'

export interface TestUser {
  id: string
  displayName: string
  walletAddress: string
  isActive: boolean
}

export interface TestPosition {
  id: string
  userId: string
  protocolName: string
  assetSymbol: string
  depositedAmount: string
  currentValue: string
  yieldEarned: string
  status: 'ACTIVE' | 'INACTIVE'
}

export interface TestYieldSnapshot {
  id: string
  positionId: string
  snapshotAt: Date
  apy: number
  yieldAmount: number
  principalAmount: number
}

export interface TestProtocolRate {
  id: string
  protocolName: string
  assetSymbol: string
  supplyApy: number
  tvl: number | null
  fetchedAt: Date
  network: string
}

export interface TestSession {
  id: string
  token: string
  userId: string
  sessionId: string
  expiresAt: Date
  walletAddress: string
  network: string
}

/**
 * Create a test user
 */
export async function createTestUser(
  prisma: PrismaClient,
  overrides: Partial<TestUser> = {}
): Promise<TestUser> {
  const userData = {
    id: overrides.id || `test-user-${Date.now()}`,
    displayName: overrides.displayName || 'Test User',
    walletAddress: overrides.walletAddress || 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTICSQYY2T4YJJWUDLVXVVU6G',
    isActive: overrides.isActive !== undefined ? overrides.isActive : true,
  }

  const user = await prisma.user.create({
    data: userData,
  })

  return user as TestUser
}

/**
 * Create a test position
 */
export async function createTestPosition(
  prisma: PrismaClient,
  userId: string,
  overrides: Partial<TestPosition> = {}
): Promise<TestPosition> {
  const positionData = {
    id: overrides.id || `test-position-${Date.now()}`,
    userId,
    protocolName: overrides.protocolName || 'blend',
    assetSymbol: overrides.assetSymbol || 'USDC',
    depositedAmount: overrides.depositedAmount || '1000',
    currentValue: overrides.currentValue || '1000',
    yieldEarned: overrides.yieldEarned || '0',
    status: overrides.status || 'ACTIVE',
  }

  const position = await prisma.position.create({
    data: positionData,
  })

  return position as TestPosition
}

/**
 * Create test yield snapshots
 */
export async function createTestYieldSnapshots(
  prisma: PrismaClient,
  positionId: string,
  count: number = 5,
  startDate?: Date
): Promise<TestYieldSnapshot[]> {
  const snapshots: TestYieldSnapshot[] = []
  const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago

  for (let i = 0; i < count; i++) {
    const snapshotDate = new Date(start.getTime() + i * 24 * 60 * 60 * 1000) // Daily snapshots
    const snapshot = await prisma.yieldSnapshot.create({
      data: {
        id: `test-snapshot-${positionId}-${i}`,
        positionId,
        snapshotAt: snapshotDate,
        apy: 5 + Math.random() * 2, // Random APY between 5-7%
        yieldAmount: 10 + Math.random() * 20, // Random yield between 10-30
        principalAmount: 1000,
      },
    })
    snapshots.push(snapshot as TestYieldSnapshot)
  }

  return snapshots
}

/**
 * Create test protocol rates
 */
export async function createTestProtocolRates(
  prisma: PrismaClient,
  count: number = 10,
  startDate?: Date
): Promise<TestProtocolRate[]> {
  const rates: TestProtocolRate[] = []
  const protocols = ['blend', 'aquarius', 'blueshift']
  const assets = ['USDC', 'XLM']
  const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago

  for (let i = 0; i < count; i++) {
    const rateDate = new Date(start.getTime() + i * 3 * 24 * 60 * 60 * 1000) // Every 3 days
    const protocol = protocols[i % protocols.length]
    const asset = assets[i % assets.length]
    
    const rate = await prisma.protocolRate.create({
      data: {
        id: `test-rate-${i}`,
        protocolName: protocol,
        assetSymbol: asset,
        supplyApy: 3 + Math.random() * 5, // Random APY between 3-8%
        tvl: Math.random() > 0.5 ? 1000000 + Math.random() * 5000000 : null, // Random TVL or null
        fetchedAt: rateDate,
        network: 'TESTNET',
      },
    })
    rates.push(rate as TestProtocolRate)
  }

  return rates
}

/**
 * Create a test session
 */
export async function createTestSession(
  prisma: PrismaClient,
  userId: string,
  overrides: Partial<TestSession> = {}
): Promise<TestSession> {
  const sessionData = {
    id: overrides.id || `test-session-${Date.now()}`,
    token: overrides.token || `test-token-${Date.now()}`,
    userId,
    sessionId: overrides.sessionId || `sess-${Date.now()}`,
    expiresAt: overrides.expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
    walletAddress: overrides.walletAddress || 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTICSQYY2T4YJJWUDLVXVVU6G',
    network: overrides.network || 'TESTNET',
  }

  const session = await prisma.session.create({
    data: sessionData,
  })

  return session as TestSession
}

/**
 * Setup complete test data for analytics endpoints
 */
export async function setupAnalyticsTestData(
  prisma: PrismaClient,
  options: {
    userCount?: number
    positionsPerUser?: number
    snapshotsPerPosition?: number
    protocolRateCount?: number
  } = {}
) {
  const {
    userCount = 1,
    positionsPerUser = 2,
    snapshotsPerPosition = 5,
    protocolRateCount = 10,
  } = options

  const users: TestUser[] = []
  const positions: TestPosition[] = []
  const snapshots: TestYieldSnapshot[] = []
  const sessions: TestSession[] = []

  // Create users
  for (let i = 0; i < userCount; i++) {
    const user = await createTestUser(prisma, {
      id: `test-user-${i}`,
      displayName: `Test User ${i}`,
    })
    users.push(user)

    // Create session for first user (for authenticated tests)
    if (i === 0) {
      const session = await createTestSession(prisma, user.id)
      sessions.push(session)
    }

    // Create positions
    for (let j = 0; j < positionsPerUser; j++) {
      const position = await createTestPosition(prisma, user.id, {
        id: `test-position-${i}-${j}`,
        protocolName: j % 2 === 0 ? 'blend' : 'aquarius',
        assetSymbol: j % 2 === 0 ? 'USDC' : 'XLM',
      })
      positions.push(position)

      // Create yield snapshots
      const positionSnapshots = await createTestYieldSnapshots(
        prisma,
        position.id,
        snapshotsPerPosition
      )
      snapshots.push(...positionSnapshots)
    }
  }

  // Create protocol rates
  const protocolRates = await createTestProtocolRates(prisma, protocolRateCount)

  return {
    users,
    positions,
    snapshots,
    protocolRates,
    sessions,
  }
}

/**
 * Cleanup analytics test data
 */
export async function cleanupAnalyticsTestData(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction([
    prisma.yieldSnapshot.deleteMany(),
    prisma.protocolRate.deleteMany(),
    prisma.position.deleteMany(),
    prisma.session.deleteMany(),
    prisma.user.deleteMany(),
  ])
}

/**
 * Create test data for grouped protocol structures
 */
export async function createGroupedProtocolTestData(
  prisma: PrismaClient
): Promise<TestProtocolRate[]> {
  const protocols = ['blend', 'aquarius', 'blueshift']
  const assets = ['USDC', 'XLM']
  const networks = ['TESTNET', 'MAINNET']
  const rates: TestProtocolRate[] = []

  // Create rates for each combination of protocol/asset/network
  for (const protocol of protocols) {
    for (const asset of assets) {
      for (const network of networks) {
        for (let i = 0; i < 3; i++) {
          const rate = await prisma.protocolRate.create({
            data: {
              id: `test-rate-${protocol}-${asset}-${network}-${i}`,
              protocolName: protocol,
              assetSymbol: asset,
              supplyApy: 3 + Math.random() * 5,
              tvl: Math.random() > 0.3 ? 1000000 + Math.random() * 5000000 : null,
              fetchedAt: new Date(Date.now() - i * 7 * 24 * 60 * 60 * 1000), // Weekly snapshots
              network,
            },
          })
          rates.push(rate as TestProtocolRate)
        }
      }
    }
  }

  return rates
}

/**
 * Create test data for validation failure scenarios
 */
export async function createValidationFailureTestData(
  prisma: PrismaClient
): Promise<{ user: TestUser; session: TestSession }> {
  const user = await createTestUser(prisma, {
    id: 'validation-test-user',
    displayName: 'Validation Test User',
  })

  const session = await createTestSession(prisma, user.id, {
    id: 'validation-test-session',
    token: 'validation-test-token',
  })

  return { user, session }
}
