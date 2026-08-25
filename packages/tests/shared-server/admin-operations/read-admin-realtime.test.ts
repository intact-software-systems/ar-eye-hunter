import { describe, expect, it } from 'vitest';

import { ReadAdminRealtime } from '@shared-server/rallar-system/admin-operations/read-admin-realtime.ts';
import { emptyGroupFormationMetrics } from '@shared-server/rallar-system/observability/formation-metrics.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;

describe('ReadAdminRealtime', () => {
    it('reads the current websocket and process-local metric owners', async () => {
        const formationMetrics = {
            ...emptyGroupFormationMetrics(),
            presenceSummaryExpansionCount: 4
        };
        const readRealtime = new ReadAdminRealtime({
            nowEpochMs: () => NOW_EPOCH_MS,
            serverId: 'test-server',
            readWebSocketStatus: () => ({
                transport: 'ws-server',
                connectionCount: 2,
                openConnectionCount: 1,
                connectionIds: ['closed-1', 'open-1'],
                openConnectionIds: ['open-1'],
                connections: [
                    { connectionId: 'closed-1', isOpen: false },
                    { connectionId: 'open-1', isOpen: true }
                ]
            }),
            readRtcTopologyMetrics: () => ({ recomputeCount: 2 }),
            readGroupFormationMetrics: () => formationMetrics
        });

        await expect(readRealtime.execute({
            adminSession: createAdminSession()
        })).resolves.toMatchObject({
            generatedAtEpochMs: NOW_EPOCH_MS,
            serverId: 'test-server',
            websocket: {
                connectionCount: 2,
                openConnectionCount: 1,
                connectionIds: ['closed-1', 'open-1'],
                openConnectionIds: ['open-1']
            },
            rtcTopology: {
                metrics: { recomputeCount: 2 },
                processLocal: true
            },
            groupFormation: {
                metrics: formationMetrics,
                processLocal: true
            }
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
