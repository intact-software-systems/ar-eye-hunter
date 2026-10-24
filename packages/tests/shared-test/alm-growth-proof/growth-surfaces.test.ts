import {
    describe,
    expect,
    it
} from 'vitest';

import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import {
    GROWTH_SURFACES,
    GROWTH_SURVEY_SURFACE_IDS
} from '../../../shared-test/rallar-bb-test/alm/growth-proof/growth-surfaces.ts';
import { computeGrowthVerdict } from '../../../shared-test/rallar-bb-test/alm/growth-proof/growth-verdict.ts';
import { readMediumScaleChurnClientCount } from '../api-v1-recipe-test-fixture.ts';

describe('Growth surface classification', () => {
    it('classifies every surface of the growth survey, each with at least one reader', () => {
        const ids = GROWTH_SURFACES.map((surface) => surface.id);
        const names = GROWTH_SURFACES.map((surface) => surface.name);

        expect(new Set(names).size).toBe(names.length);
        expect(GROWTH_SURVEY_SURFACE_IDS).toHaveLength(75);
        expect(GROWTH_SURVEY_SURFACE_IDS.filter((id) => !ids.includes(id))).toEqual([]);
        expect(GROWTH_SURFACES.filter((surface) => surface.readers.length === 0)).toEqual([]);
    });

    it('keeps each runtime-state namespace with one surface, so a namespace has one class', () => {
        const namespaces = GROWTH_SURFACES.flatMap((surface) =>
            surface.readers
                .filter((reader) => reader.source === 'postgres' && reader.path[1] === 'byNamespace')
                .map((reader) => reader.path[2])
        );

        expect(new Set(namespaces).size).toBe(namespaces.length);
    });

    it('guards the resource_inbox total against rows stamped never to expire', () => {
        const total = GROWTH_SURFACES.find((surface) => surface.id === 1);

        expect(total?.classification.growthClass).toBe('ttl-beyond-run');
        expect(total?.readers).toEqual([{
            source: 'postgres',
            path: ['resourceInbox', 'total'],
            absent: 'zero',
            neverExpiringPath: ['resourceInbox', 'neverExpireSettled']
        }]);
    });

    // An APP_INBOX fact is stamped never to expire until its finish gives it the retention expiry, so the facts in
    // flight at a sample come and go; only the settled rows say whether something never expires.
    it('passes the resource_inbox total while its in-flight facts come and go, and fails it when settled rows rise', () => {
        const total = GROWTH_SURFACES.find((surface) => surface.id === 1)!;
        const windowStartedAtEpochMs = 1_800_000_000_000;
        const toSamples = (settledAt: (sample: number) => number) =>
            Array.from({ length: 151 }, (_value, sample) => ({
                atEpochMs: windowStartedAtEpochMs + sample * 30_000,
                agentId: null,
                serviceId: null,
                value: {
                    resourceInbox: {
                        total: 1_000 + sample * 10,
                        neverExpire: (sample % 4) * 4 + settledAt(sample),
                        neverExpireSettled: settledAt(sample)
                    }
                } satisfies ApiJsonValue
            }));
        const computeOutcome = (settledAt: (sample: number) => number) =>
            computeGrowthVerdict({
                surveyedSurfaceIds: [1],
                surfaces: [total],
                run: {
                    windowStartedAtEpochMs,
                    workload: {
                        runner: 'passed',
                        manifestStartedAtEpochMs: windowStartedAtEpochMs,
                        manifestCompletedAtEpochMs: windowStartedAtEpochMs + 4_500_000,
                        manifestAgents: 15,
                        eventHistoryMaxEvents: 10_000,
                        groupCurrentSnapshotCacheMaxEntries: 32,
                        apiProcesses: 3,
                        churnStarted: 1,
                        churnPassed: 1,
                        churnFailedRunIds: []
                    }
                },
                samples: {
                    postgres: toSamples(settledAt),
                    'admin-system': [],
                    'admin-queues': [],
                    'admin-realtime': [],
                    'api-heap': [],
                    'process-rss': [],
                    'browser-stats': []
                }
            }).rows[0]?.outcome;

        expect(computeOutcome(() => 0)).toBe('pass');
        expect(computeOutcome((sample) => sample)).toBe('fail');
    });

    // An account is registered before its principal connects, so mid-iteration the auth users run ahead of the
    // principals; what bounds them is the accounts the run registered.
    it('bounds the auth users by the accounts the run registered, and the client ids by the usernames', () => {
        const authUsers = GROWTH_SURFACES.find((surface) => surface.readers.some((reader) => reader.path.includes('auth-users:by-username')))!;
        const windowStartedAtEpochMs = 1_800_000_000_000;
        const toWorkload = (churnStarted: number) => ({
            runner: 'passed' as const,
            manifestStartedAtEpochMs: windowStartedAtEpochMs,
            manifestCompletedAtEpochMs: windowStartedAtEpochMs + 4_500_000,
            manifestAgents: 15,
            eventHistoryMaxEvents: 10_000,
            groupCurrentSnapshotCacheMaxEntries: 32,
            apiProcesses: 3,
            churnStarted,
            churnPassed: churnStarted,
            churnFailedRunIds: []
        });
        // One iteration every 5 minutes registers its 100 accounts; the sample at :30 of each catches 5 not yet
        // connected, and `clientIdsAhead` adds client-id rows no username has.
        const toSamples = (clientIdsAhead: number) =>
            Array.from({ length: 151 }, (_value, sample) => {
                const iterations = Math.min(14, Math.floor(sample / 10) + 1);
                const usernames = 15 + iterations * 100;
                return {
                    atEpochMs: windowStartedAtEpochMs + sample * 30_000,
                    agentId: null,
                    serviceId: null,
                    value: {
                        runtimeState: {
                            byNamespace: {
                                'auth-users:by-username': usernames,
                                'auth-users:by-client-id': usernames + (sample === 100 ? clientIdsAhead : 0),
                                'client-state:principals': usernames - (sample % 10 === 1 ? 5 : 0)
                            }
                        }
                    } satisfies ApiJsonValue
                };
            });
        const computeOutcomes = (churnStarted: number, clientIdsAhead: number) =>
            computeGrowthVerdict({
                surveyedSurfaceIds: [authUsers.id],
                surfaces: [authUsers],
                run: { windowStartedAtEpochMs, workload: toWorkload(churnStarted) },
                samples: {
                    postgres: toSamples(clientIdsAhead),
                    'admin-system': [],
                    'admin-queues': [],
                    'admin-realtime': [],
                    'api-heap': [],
                    'process-rss': [],
                    'browser-stats': []
                }
            }).rows.filter((row) => row.surfaceId === authUsers.id).map((row) => row.outcome);

        expect(computeOutcomes(14, 0)).toEqual(['pass', 'pass']);
        expect(computeOutcomes(12, 0)).toEqual(['fail', 'fail']);
        expect(computeOutcomes(14, 1)).toEqual(['pass', 'fail']);
    });

    it('counts per churn iteration the clients the medium-scale churn recipe registers', () => {
        const authUsers = GROWTH_SURFACES.find((surface) => surface.readers.some((reader) => reader.path.includes('auth-users:by-username')));

        expect(authUsers?.classification).toMatchObject({
            entityCount: { source: 'registrations', principalsPerChurnIteration: readMediumScaleChurnClientCount() }
        });
    });

    // A durable outbound pair keeps a message's rows until its deadline when that is later than the row ttl, and a
    // WS_OUTBOX message's deadline is a day: the proof's probe found every sent, owner and ordering row stamped 24 h.
    it('bounds the server outbound admission rows by the day their WS_OUTBOX messages live, the inbound by the hour', () => {
        const toClassification = (namespace: string) =>
            GROWTH_SURFACES.find((surface) => surface.readers.some((reader) => reader.path.includes(namespace)))?.classification;

        expect(toClassification('server-ws-qbox:*:outbound:admission')).toEqual({
            growthClass: 'ttl-beyond-run',
            ttlMs: 86_400_000
        });
        expect(toClassification('server-ws-qbox:*:inbound:admission')).toEqual({
            growthClass: 'ttl-within-run',
            ttlMs: 3_600_000,
            sweepMs: 60_000
        });
    });

    it('bounds a page\'s delivered markers at 256 per inbound store across its two stores', () => {
        const markers = GROWTH_SURFACES.find((surface) => surface.id === 49);

        expect(markers?.classification).toEqual({ growthClass: 'count-capped', cap: 512 });
    });

    describe('group current-snapshot cache', () => {
        const audience = GROWTH_SURFACES.filter((surface) => surface.id === 20 || surface.id === 21);
        const windowStartedAtEpochMs = 1_800_000_000_000;
        const toWorkload = (groupCurrentSnapshotCacheMaxEntries: number) => ({
            runner: 'passed' as const,
            manifestStartedAtEpochMs: windowStartedAtEpochMs,
            manifestCompletedAtEpochMs: windowStartedAtEpochMs + 4_500_000,
            manifestAgents: 15,
            eventHistoryMaxEvents: 10_000,
            groupCurrentSnapshotCacheMaxEntries,
            apiProcesses: 3,
            churnStarted: 1,
            churnPassed: 1,
            churnFailedRunIds: []
        });
        // One API process reporting every 30 s for 20 minutes; its last reading is `lastKept`.
        const toSamples = (lastKept: number) =>
            Array.from({ length: 41 }, (_value, sample) => ({
                atEpochMs: windowStartedAtEpochMs + sample * 30_000,
                agentId: null,
                serviceId: 'server-1',
                value: { caches: { groupAudienceSnapshots: sample === 40 ? lastKept : sample } } satisfies ApiJsonValue
            }));
        const computeRows = (workload: ReturnType<typeof toWorkload>, adminRealtime: ReturnType<typeof toSamples>) =>
            computeGrowthVerdict({
                surveyedSurfaceIds: audience.map((surface) => surface.id),
                surfaces: audience,
                run: { windowStartedAtEpochMs, workload },
                samples: {
                    postgres: [],
                    'admin-system': [],
                    'admin-queues': [],
                    'admin-realtime': adminRealtime,
                    'api-heap': [],
                    'process-rss': [],
                    'browser-stats': []
                }
            }).rows;

        it('bounds both rows by the cache cap the run started its API processes with', () => {
            const kept = computeRows(toWorkload(512), toSamples(71));
            const overCap = computeRows(toWorkload(32), toSamples(71));

            expect(kept.map((row) => [row.outcome, row.bound])).toEqual([['pass', '≤ 512'], ['pass', '≤ 512']]);
            expect(overCap.map((row) => [row.outcome, row.bound])).toEqual([['fail', '≤ 32'], ['fail', '≤ 32']]);
        });
    });

    it('bounds the topology idempotency records by the 24-hour finished retention, guarded against rows without expiry', () => {
        const configMutations = GROWTH_SURFACES.find((surface) => surface.readers.some((reader) => reader.path.includes('group-topology:config-mutation')));

        expect(configMutations?.classification).toEqual({ growthClass: 'ttl-beyond-run', ttlMs: 86_400_000 });
        expect(configMutations?.readers[0]?.neverExpiringPath).toEqual([
            'runtimeState',
            'neverExpireByNamespace',
            'group-topology:config-mutation'
        ]);
    });

    describe('black-box runtime event history', () => {
        const surface = GROWTH_SURFACES.find((candidate) => candidate.readers.some((reader) => reader.path.join('.') === 'eventHistory.retainedEvents'))!;
        const windowStartedAtEpochMs = 1_800_000_000_000;
        const toWorkload = (eventHistoryMaxEvents: number) => ({
            runner: 'passed' as const,
            manifestStartedAtEpochMs: windowStartedAtEpochMs,
            manifestCompletedAtEpochMs: windowStartedAtEpochMs + 4_500_000,
            manifestAgents: 15,
            eventHistoryMaxEvents,
            groupCurrentSnapshotCacheMaxEntries: 32,
            apiProcesses: 3,
            churnStarted: 1,
            churnPassed: 1,
            churnFailedRunIds: []
        });
        // Two agents reporting every 30 s for 20 minutes; the second agent's last reading is `lastRetained`.
        const toSamples = (lastRetained: number) =>
            ['controller-01', 'controller-02'].flatMap((agentId, agent) =>
                Array.from({ length: 41 }, (_value, sample) => ({
                    atEpochMs: windowStartedAtEpochMs + sample * 30_000,
                    agentId,
                    serviceId: null,
                    value: {
                        eventHistory: { retainedEvents: agent === 1 && sample === 40 ? lastRetained : sample * 200 }
                    } satisfies ApiJsonValue
                }))
            );
        const computeRow = (workload: ReturnType<typeof toWorkload> | null, browserStats: ReturnType<typeof toSamples>) =>
            computeGrowthVerdict({
                surveyedSurfaceIds: [surface.id],
                surfaces: [surface],
                run: { windowStartedAtEpochMs, workload },
                samples: {
                    postgres: [],
                    'admin-system': [],
                    'admin-queues': [],
                    'admin-realtime': [],
                    'api-heap': [],
                    'process-rss': [],
                    'browser-stats': browserStats
                }
            }).rows[0]!;

        it('passes while every agent retains at most the events the workload bounds, and fails one above', () => {
            expect(computeRow(toWorkload(10_000), toSamples(10_000)).outcome).toBe('pass');
            expect(computeRow(toWorkload(10_000), toSamples(10_001)).outcome).toBe('fail');
        });

        it('takes the bound from the workload the run recorded', () => {
            const row = computeRow(toWorkload(5_000), toSamples(5_001));

            expect(row.outcome).toBe('fail');
            expect(row.bound).toBe('≤ 5000');
        });

        it('has no data without a reading, and none while the run recorded no workload to take the bound from', () => {
            expect(computeRow(toWorkload(10_000), []).outcome).toBe('no-data');
            expect(computeRow(null, toSamples(100)).outcome).toBe('no-data');
        });
    });
});
