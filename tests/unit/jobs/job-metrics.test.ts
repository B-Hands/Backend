const mockInc = jest.fn()
const mockObserve = jest.fn()

jest.mock('prom-client', () => {
  return {
    __esModule: true,
    default: {
      Counter: jest.fn().mockImplementation(() => ({ inc: mockInc })),
      Histogram: jest.fn().mockImplementation(() => ({ observe: mockObserve })),
      Registry: jest.fn().mockImplementation(() => ({
        registerMetric: jest.fn(),
        resetMetrics: jest.fn(),
        metrics: jest.fn().mockResolvedValue(''),
        setDefaultLabels: jest.fn(),
      })),
      register: {
        registerMetric: jest.fn(),
        resetMetrics: jest.fn(),
        metrics: jest.fn().mockResolvedValue(''),
        setDefaultLabels: jest.fn(),
        collectDefaultMetrics: jest.fn(),
      },
    },
    collectDefaultMetrics: jest.fn(),
    register: {
      registerMetric: jest.fn(),
      resetMetrics: jest.fn(),
      metrics: jest.fn().mockResolvedValue(''),
      setDefaultLabels: jest.fn(),
    },
    Registry: jest.fn().mockImplementation(() => ({
      registerMetric: jest.fn(),
      resetMetrics: jest.fn(),
      metrics: jest.fn().mockResolvedValue(''),
      setDefaultLabels: jest.fn(),
    })),
    Counter: jest.fn().mockImplementation(() => ({ inc: mockInc })),
    Histogram: jest.fn().mockImplementation(() => ({ observe: mockObserve })),
  }
})

jest.mock('../../../src/utils/metrics-registry', () => ({
  register: {
    registerMetric: jest.fn(),
    resetMetrics: jest.fn(),
    metrics: jest.fn().mockResolvedValue(''),
    setDefaultLabels: jest.fn(),
  },
}))

import { recordJobSuccess, recordJobFailure } from '../../../src/utils/job-metrics'

describe('job-metrics', () => {
  beforeEach(() => {
    mockInc.mockClear()
    mockObserve.mockClear()
  })

  describe('recordJobSuccess', () => {
    it('increments job_success_total with the correct job_name label', () => {
      recordJobSuccess('session_cleanup', 250)
      expect(mockInc).toHaveBeenCalledWith({ job_name: 'session_cleanup' })
    })

    it('observes job_duration_ms with the correct job_name label and duration', () => {
      recordJobSuccess('retention_auth_nonces', 450)
      expect(mockObserve).toHaveBeenCalledWith({ job_name: 'retention_auth_nonces' }, 450)
    })

    it('does not call inc on the failure counter', () => {
      mockInc.mockClear()
      recordJobSuccess('retention_agent_logs', 100)
      // inc is called exactly once (success counter only)
      expect(mockInc).toHaveBeenCalledTimes(1)
      expect(mockInc).toHaveBeenCalledWith({ job_name: 'retention_agent_logs' })
    })
  })

  describe('recordJobFailure', () => {
    it('increments job_failure_total with the correct job_name label', () => {
      recordJobFailure('session_cleanup', 300)
      expect(mockInc).toHaveBeenCalledWith({ job_name: 'session_cleanup' })
    })

    it('observes job_duration_ms with the correct job_name label and duration', () => {
      recordJobFailure('retention_processed_events', 750)
      expect(mockObserve).toHaveBeenCalledWith({ job_name: 'retention_processed_events' }, 750)
    })

    it('does not call inc on the success counter', () => {
      mockInc.mockClear()
      recordJobFailure('retention_dead_letter_events', 200)
      // inc is called exactly once (failure counter only)
      expect(mockInc).toHaveBeenCalledTimes(1)
      expect(mockInc).toHaveBeenCalledWith({ job_name: 'retention_dead_letter_events' })
    })
  })
})
