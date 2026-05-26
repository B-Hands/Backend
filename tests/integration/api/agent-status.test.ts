/**
 * Integration tests — Agent status endpoint improvements
 *
 * Tests that /api/protocols/agent/status returns real agent loop health
 */

jest.mock('../../../src/agent/loop', () => ({
    getAgentStatus: jest.fn().mockReturnValue({
        isRunning: true,
        lastRebalanceAt: new Date('2026-05-26T10:00:00Z'),
        currentProtocol: 'Blend',
        currentApy: 4.25,
        nextScheduledCheck: new Date('2026-05-26T11:00:00Z'),
        lastError: null,
        healthStatus: 'healthy',
    }),
}));

const mockDb = {
    agentLog: {
        findFirst: jest.fn().mockResolvedValue({
            id: 'log-1',
            status: 'SUCCESS',
            action: 'ANALYZE',
            details: { positionsChecked: 5, rebalancesTriggered: 1 },
            createdAt: new Date('2026-05-26T10:00:00Z'),
        }),
    },
    protocolRate: {
        findMany: jest.fn().mockResolvedValue([]),
    },
};

jest.mock('../../../src/db', () => ({
    __esModule: true,
    default: mockDb,
}));

jest.mock('../../../src/whatsapp/formatters', () => ({
    formatAgentStatusReply: jest.fn().mockReturnValue('Agent is healthy and running'),
    formatProtocolRatesReply: jest.fn().mockReturnValue('Protocol rates updated'),
}));

import request from 'supertest';
import app from '../../../src/index';

describe('Agent Status Endpoint - Real Health Tracking', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/protocols/agent/status', () => {
        it('returns real agent loop health status', async () => {
            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toHaveProperty('isRunning');
            expect(res.body.data).toHaveProperty('healthStatus');
            expect(res.body.data).toHaveProperty('lastRebalanceAt');
            expect(res.body.data).toHaveProperty('currentProtocol');
            expect(res.body.data).toHaveProperty('currentApy');
            expect(res.body.data).toHaveProperty('nextScheduledCheck');
            expect(res.body.data).toHaveProperty('lastError');
        });

        it('returns isRunning from agent loop', async () => {
            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.isRunning).toBe(true);
        });

        it('returns healthStatus from agent loop', async () => {
            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.healthStatus).toBe('healthy');
        });

        it('returns lastRebalanceAt as ISO string', async () => {
            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.lastRebalanceAt).toBe('2026-05-26T10:00:00.000Z');
        });

        it('returns currentProtocol from agent loop', async () => {
            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.currentProtocol).toBe('Blend');
        });

        it('returns currentApy as formatted number', async () => {
            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.currentApy).toBe(4.25);
        });

        it('returns nextScheduledCheck as ISO string', async () => {
            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.nextScheduledCheck).toBe('2026-05-26T11:00:00.000Z');
        });

        it('returns lastError when agent has errors', async () => {
            const { getAgentStatus } = require('../../../src/agent/loop');
            getAgentStatus.mockReturnValueOnce({
                isRunning: true,
                lastRebalanceAt: new Date('2026-05-26T10:00:00Z'),
                currentProtocol: 'Blend',
                currentApy: 4.25,
                nextScheduledCheck: new Date('2026-05-26T11:00:00Z'),
                lastError: 'RPC connection timeout',
                healthStatus: 'degraded',
            });

            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.lastError).toBe('RPC connection timeout');
            expect(res.body.data.healthStatus).toBe('degraded');
        });

        it('returns null for lastError when no errors', async () => {
            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.lastError).toBeNull();
        });

        it('includes latest log as supplemental information', async () => {
            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.latestLog).toBeDefined();
            expect(res.body.data.latestLog.status).toBe('SUCCESS');
            expect(res.body.data.latestLog.action).toBe('ANALYZE');
            expect(res.body.data.latestLog.createdAt).toBeDefined();
        });

        it('returns null for latestLog when no logs exist', async () => {
            mockDb.agentLog.findFirst.mockResolvedValueOnce(null);

            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.latestLog).toBeNull();
        });

        it('includes timestamp in response', async () => {
            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.timestamp).toBeDefined();
            expect(res.body.data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });

        it('includes whatsappReply for natural language clients', async () => {
            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.whatsappReply).toBeDefined();
            expect(typeof res.body.whatsappReply).toBe('string');
        });

        it('handles agent not running', async () => {
            const { getAgentStatus } = require('../../../src/agent/loop');
            getAgentStatus.mockReturnValueOnce({
                isRunning: false,
                lastRebalanceAt: null,
                currentProtocol: null,
                currentApy: null,
                nextScheduledCheck: new Date(),
                lastError: 'Agent failed to start',
                healthStatus: 'error',
            });

            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.isRunning).toBe(false);
            expect(res.body.data.healthStatus).toBe('error');
            expect(res.body.data.lastRebalanceAt).toBeNull();
            expect(res.body.data.currentProtocol).toBeNull();
            expect(res.body.data.currentApy).toBeNull();
        });

        it('formats APY to 2 decimal places', async () => {
            const { getAgentStatus } = require('../../../src/agent/loop');
            getAgentStatus.mockReturnValueOnce({
                isRunning: true,
                lastRebalanceAt: new Date(),
                currentProtocol: 'Blend',
                currentApy: 4.256789,
                nextScheduledCheck: new Date(),
                lastError: null,
                healthStatus: 'healthy',
            });

            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.currentApy).toBe(4.26);
        });

        it('returns 500 on error', async () => {
            const { getAgentStatus } = require('../../../src/agent/loop');
            getAgentStatus.mockImplementationOnce(() => {
                throw new Error('Agent status retrieval failed');
            });

            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.status).toBe(500);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBeDefined();
        });
    });

    describe('Response structure', () => {
        it('follows standard API response format', async () => {
            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body).toHaveProperty('success');
            expect(res.body).toHaveProperty('data');
            expect(res.body).toHaveProperty('whatsappReply');
            expect(res.body.data).toHaveProperty('timestamp');
        });

        it('data object contains all required fields', async () => {
            const res = await request(app).get('/api/protocols/agent/status');

            const requiredFields = [
                'isRunning',
                'healthStatus',
                'lastRebalanceAt',
                'currentProtocol',
                'currentApy',
                'nextScheduledCheck',
                'lastError',
                'latestLog',
            ];

            for (const field of requiredFields) {
                expect(res.body.data).toHaveProperty(field);
            }
        });

        it('latestLog contains action, status, and createdAt', async () => {
            const res = await request(app).get('/api/protocols/agent/status');

            if (res.body.data.latestLog) {
                expect(res.body.data.latestLog).toHaveProperty('status');
                expect(res.body.data.latestLog).toHaveProperty('action');
                expect(res.body.data.latestLog).toHaveProperty('createdAt');
            }
        });
    });

    describe('Health status determination', () => {
        it('returns healthy when running with no errors', async () => {
            const { getAgentStatus } = require('../../../src/agent/loop');
            getAgentStatus.mockReturnValueOnce({
                isRunning: true,
                lastRebalanceAt: new Date(),
                currentProtocol: 'Blend',
                currentApy: 4.25,
                nextScheduledCheck: new Date(),
                lastError: null,
                healthStatus: 'healthy',
            });

            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.healthStatus).toBe('healthy');
        });

        it('returns degraded when running with errors', async () => {
            const { getAgentStatus } = require('../../../src/agent/loop');
            getAgentStatus.mockReturnValueOnce({
                isRunning: true,
                lastRebalanceAt: new Date(),
                currentProtocol: 'Blend',
                currentApy: 4.25,
                nextScheduledCheck: new Date(),
                lastError: 'Some error occurred',
                healthStatus: 'degraded',
            });

            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.healthStatus).toBe('degraded');
        });

        it('returns error when not running', async () => {
            const { getAgentStatus } = require('../../../src/agent/loop');
            getAgentStatus.mockReturnValueOnce({
                isRunning: false,
                lastRebalanceAt: null,
                currentProtocol: null,
                currentApy: null,
                nextScheduledCheck: new Date(),
                lastError: 'Agent crashed',
                healthStatus: 'error',
            });

            const res = await request(app).get('/api/protocols/agent/status');

            expect(res.body.data.healthStatus).toBe('error');
        });
    });
});
