import { describe, expect, it } from 'vitest';

import { ResetAdminMetrics } from '@shared-server/rallar-system/admin-operations/reset-admin-metrics.ts';
import { emptyGroupFormationMetrics } from '@shared-server/rallar-system/observability/formation-metrics.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { createRtcTopologyAdminMetrics } from './test-support/create-rtc-topology-admin-metrics.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;

describe('ResetAdminMetrics', () => {
    it('resets only the requested metric owner and records explicit timing facts', async () => {
        const events: RallarTimingEvent[] = [];
        const resets: string[] = [];
        let topologyMetrics = createRtcTopologyAdminMetrics({ topologyUpdateCount: 2 });
        const resetMetrics = new ResetAdminMetrics({
            nowEpochMs: () => NOW_EPOCH_MS,
            serverId: 'test-server',
            timing: (event) => events.push(event),
            rtcTopology: {
                read: () => topologyMetrics,
                reset: () => {
                    resets.push('rtc-topology');
                    topologyMetrics = createRtcTopologyAdminMetrics();
                }
            },
            groupFormation: {
                read: emptyGroupFormationMetrics,
                reset: () => resets.push('group-formation')
            }
        });

        const result = await resetMetrics.execute({
            adminSession: createAdminSession(),
            request: {
                requestId: 'reset-1',
                categories: ['rtc-topology'],
                reason: 'operator-test'
            }
        });

        expect(resets).toEqual(['rtc-topology']);
        expect(result).toMatchObject({
            generatedAtEpochMs: NOW_EPOCH_MS,
            serverId: 'test-server',
            operation: 'metrics.reset',
            status: 'completed',
            changed: true,
            before: { rtcTopology: createRtcTopologyAdminMetrics({ topologyUpdateCount: 2 }) },
            after: { rtcTopology: createRtcTopologyAdminMetrics() }
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            component: 'admin-operations',
            operation: 'metrics.reset',
            status: 'ok',
            requestId: 'reset-1',
            principalId: 'platform-admin',
            sessionId: 'admin-session',
            details: {
                adminClientId: 'platform-admin',
                reason: 'operator-test',
                categories: 'rtc-topology',
                changed: true,
                operationStatus: 'completed'
            }
        });
    });

    it('reports only the requested category in the before and after snapshots', async () => {
        const formationMetrics = emptyGroupFormationMetrics();
        const resetMetrics = new ResetAdminMetrics({
            nowEpochMs: () => NOW_EPOCH_MS,
            rtcTopology: {
                read: () => createRtcTopologyAdminMetrics(),
                reset: () => {}
            },
            groupFormation: {
                read: () => formationMetrics,
                reset: () => {}
            }
        });

        const result = await resetMetrics.execute({
            adminSession: createAdminSession(),
            request: { categories: ['group-formation'] }
        });

        expect(result.before).toEqual({ groupFormation: formationMetrics });
        expect(result.after).toEqual({ groupFormation: formationMetrics });
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
