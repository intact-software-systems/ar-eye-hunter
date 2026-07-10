import { describe, expect, it } from 'vitest';
import {
    SPA_STATISTICS_WARNING_CODES,
    type SpaStatisticsWarningCode,
    type WorkspaceSpaStatisticsResponse,
} from '@shared/api/spa-statistics-types.ts';

describe('SPA statistics public API types', () => {
    it('publishes stable warning codes for actor-scoped statistics responses', () => {
        expect(SPA_STATISTICS_WARNING_CODES).toEqual([
            'policy-filtered-scan',
            'bounded-snapshot-scan',
            'bounded-recent-events',
            'process-local-realtime',
            'websocket-session-missing',
            'client-session-missing',
            'group-presence-filtered',
        ] satisfies readonly SpaStatisticsWarningCode[]);
    });

    it('keeps workspace summaries actor-scoped and warning-capable', () => {
        const response = {
            generatedAtEpochMs: 1_700_000_000_000,
            scope: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
            },
            actor: {
                principalId: 'alice',
                sessionId: 'alice-session',
                activeClientSessionCount: 1,
                groupPresenceCount: 1,
            },
            warnings: [
                {
                    code: 'policy-filtered-scan',
                    message: 'Only full-readable groups were counted.',
                },
            ],
            groups: {
                fullReadableCount: 1,
                joinedCount: 1,
                onlineMemberCount: 1,
            },
            activity: {
                recentVisibleGroupEventCount: {
                    count: 0,
                    limit: 20,
                    bounded: true,
                },
            },
            topGroups: [],
        } satisfies WorkspaceSpaStatisticsResponse;

        expect(response.actor.principalId).toBe('alice');
        expect(response.warnings[0]?.code).toBe('policy-filtered-scan');
    });
});
