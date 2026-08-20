import { DeadLetterQueue } from '../../../src/stellar/dlq'
import { runWithCorrelationIdAsync } from '../../../src/utils/correlation'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    deadLetterEvent: {
      create: jest.fn().mockResolvedValue({
        id: 'dlq-1',
        contractId: 'contract-1',
        txHash: 'tx-abc',
        eventType: 'deposit',
        ledger: 100,
        error: 'test error',
        payload: {},
        status: 'PENDING',
        retryCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      count: jest.fn().mockResolvedValue(1),
    },
  },
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

jest.mock('../../../src/utils/metrics', () => ({
  updateDlqSize: jest.fn(),
}))

jest.mock('../../../src/services/alerting', () => ({
  alertingService: { clearDLQAlertState: jest.fn(), emitDLQAlert: jest.fn() },
}))

jest.mock('../../../src/config', () => ({
  config: { dlq: { alertThreshold: 50 } },
}))

import db from '../../../src/db'

describe('DeadLetterQueue correlation ID', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('stores correlationId in payload metadata when available', async () => {
    const correlationId = 'event-correlation-123'
    const event = {
      contractId: 'contract-1',
      txHash: 'tx-abc',
      type: 'deposit',
      ledger: 100,
    }

    await runWithCorrelationIdAsync(correlationId, async () => {
      await DeadLetterQueue.add(event, 'processing failed')
    })

    const createCall = (db as any).deadLetterEvent.create.mock.calls[0][0]
    expect(createCall.data.payload._metadata).toEqual({ correlationId })
  })
})
