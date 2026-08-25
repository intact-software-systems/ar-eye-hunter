import { describe, expect, it } from 'vitest';

import { ReadAdminOverview } from '@shared-server/rallar-system/admin-operations/read-admin-overview.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;

describe('ReadAdminOverview', () => {
    it('projects one overview from the named admin read use cases', async () => {
        const readOverview = new ReadAdminOverview({
            nowEpochMs: () => NOW_EPOCH_MS,
            serverId: 'test-server',
            readQueues: () =>
                Promise.resolve({
                    generatedAtEpochMs: NOW_EPOCH_MS,
                    warnings: [],
                    queueRows: { total: 4, expired: 2, byTypeStatus: [], topPressure: [] },
                    resultRows: { total: 3, expired: 1, byTypeStatus: [], topPressure: [] }
                }),
            readState: () =>
                Promise.resolve({
                    generatedAtEpochMs: NOW_EPOCH_MS,
                    warnings: [],
                    clients: { totalPrincipals: 3, onlinePrincipals: 1, activeSessions: 2 },
                    groups: { activeGroups: 1, totalActiveMembers: 4, onlineMembers: 2 },
                    events: { recentClientEvents: 6, recentGroupEvents: 7 }
                }),
            readCrdt: () =>
                Promise.resolve({
                    generatedAtEpochMs: NOW_EPOCH_MS,
                    warnings: [],
                    documents: { total: 5, byLifecycle: [], byScopeType: [] },
                    storage: { updates: 8, snapshots: 2, storedUpdateBytes: 128 }
                }),
            readSystem: () =>
                Promise.resolve({
                    generatedAtEpochMs: NOW_EPOCH_MS,
                    warnings: [],
                    runtimeState: { rows: 9, expiredRows: 2, byNamespace: [] },
                    appData: { rows: 7, expiredRows: 1, byNamespaceStore: [] },
                    stateEvents: { clientEvents: 6, groupEvents: 7 },
                    configuration: {}
                }),
            readRealtime: () =>
                Promise.resolve({
                    generatedAtEpochMs: NOW_EPOCH_MS,
                    warnings: [{
                        code: 'process-local-realtime',
                        message: 'Process-local metrics',
                        source: 'ws'
                    }],
                    websocket: {
                        connectionCount: 2,
                        openConnectionCount: 1,
                        connectionIds: ['closed-1', 'open-1'],
                        openConnectionIds: ['open-1']
                    },
                    rtcTopology: { metrics: { recomputeCount: 2 }, processLocal: true },
                    groupFormation: { processLocal: true }
                })
        });

        await expect(readOverview.execute({
            adminSession: createAdminSession()
        })).resolves.toMatchObject({
            generatedAtEpochMs: NOW_EPOCH_MS,
            serverId: 'test-server',
            health: { status: 'ok' },
            websocket: { connectionCount: 2, openConnectionCount: 1 },
            queues: { queuedRows: 4, resultRows: 3, expiredRows: 3 },
            state: { activeSessions: 2, activeGroups: 1 },
            crdt: { documents: 5, updates: 8, snapshots: 2, storedUpdateBytes: 128 },
            system: { runtimeStateRows: 9, appDataRows: 7 }
        });
    });
});

function createAdminSession() {
    return {
        clientId: 'platform-admin',
        username: 'admin',
        accessToken: 'access-token',
        sessionId: 'admin-session',
        expiresAtEpochMs: NOW_EPOCH_MS + 60_000
    };
}
