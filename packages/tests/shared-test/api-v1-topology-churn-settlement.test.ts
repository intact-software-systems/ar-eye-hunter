import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecipeHttpPort, executeRecipeSegment } from './api-v1-recipe-causal-prerequisite-fixture.ts';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('topology churn final reconnect settlement', () => {
    for (
        const [groupId, readName] of [
            ['shared-group', 'readSharedGroupThroughTertiary'],
            ['churn-group', 'readChurnGroupThroughPrimary']
        ]
    ) {
        it.each([true, false])(`${groupId} requires all thirteen online accounts after a floor-bearing read; settles=%s`, async (settles) => {
            const http = createRecipeHttpPort(({ path, atEpochMs }) => {
                const observedGroupId = path.split('/groups/')[1];
                const missing = observedGroupId === groupId && (!settles || atEpochMs < 250);
                return Response.json({
                    group: { groupId: observedGroupId },
                    memberCount: 13,
                    onlineMemberCount: missing ? 12 : 13,
                    causalRevision: { groupRevision: 18, presenceRevision: missing ? 32 : 33 }
                });
            });
            const pending = executeRecipeSegment({
                recipe: 'api-v1-state-topology-churn',
                start: 'deriveLatestChurnObservation',
                end: 'readChurnGroupThroughPrimary',
                outputs: {
                    ownerAuthHeader: 'Bearer test-only',
                    ownerClientId: 'owner',
                    sharedGroupId: 'shared-group',
                    churnGroupId: 'churn-group',
                    ...Object.fromEntries(['primary', 'secondary', 'tertiary'].flatMap((server) =>
                        ['Shared', 'Churn'].flatMap((group) => [
                            [`${server}${group}GroupRevision`, 18],
                            [`${server}${group}PresenceRevision`, 31],
                            [`${server}${group}OnlineMemberCount`, 12]
                        ])
                    ))
                },
                fetch: http.fetch
            });
            await vi.runAllTimersAsync();
            const report = await pending;
            expect(report.summary.failure).toBe(settles ? 0 : 1);
            const result = report.resultsByName[readName][0];
            expect(result.actual.body.onlineMemberCount).toBe(settles ? 13 : 12);
            expect(result.pollExhausted).toBe(!settles);
            expect(result.pollElapsedMs).toBeLessThanOrEqual(15000);
            if (settles) {
                expect(result.actual.body.causalRevision.presenceRevision).toBe(33);
            }
            else {
                expect(result.status).toBe('FAILURE');
                expect(result.pollAttempts).toBe(6);
            }
        });
    }
});
