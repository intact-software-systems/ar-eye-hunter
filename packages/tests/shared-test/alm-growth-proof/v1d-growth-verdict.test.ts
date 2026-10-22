import {
    describe,
    expect,
    it
} from 'vitest';

import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { V1dGrowthSamplePoint } from '../../../shared-test/rallar-bb-test/alm/growth-proof/v1d-growth-series.ts';
import type {
    V1dGrowthClassification,
    V1dGrowthReader,
    V1dGrowthSurface
} from '../../../shared-test/rallar-bb-test/alm/growth-proof/v1d-growth-surface.ts';
import {
    computeV1dGrowthVerdict,
    type V1dGrowthRun,
    type V1dGrowthSamples,
    type V1dGrowthVerdictRow
} from '../../../shared-test/rallar-bb-test/alm/growth-proof/v1d-growth-verdict.ts';

const WINDOW_STARTED_AT_EPOCH_MS = 1_800_000_000_000;
const COMPLETED_RUN: V1dGrowthRun = {
    windowStartedAtEpochMs: WINDOW_STARTED_AT_EPOCH_MS,
    workload: {
        runner: 'passed',
        manifestStartedAtEpochMs: WINDOW_STARTED_AT_EPOCH_MS + 20_000,
        manifestCompletedAtEpochMs: WINDOW_STARTED_AT_EPOCH_MS + 4_740_000,
        churnPassed: 30,
        churnFailedRunIds: []
    }
};
const MINUTE_MS = 60_000;
const SAMPLE_INTERVAL_MS = 30_000;
const MIB = 1_048_576;
const POSTGRES_READER: V1dGrowthReader = { source: 'postgres', path: ['tables', 'surface_under_test'], absent: 'zero', neverExpiringPath: null };
const HEAP_READER: V1dGrowthReader = { source: 'api-heap', path: ['heapUsed'], absent: 'no-reading', neverExpiringPath: null };

function toPoints(
    minutes: number,
    valueAt: (elapsedMinutes: number) => ApiJsonValue
): readonly V1dGrowthSamplePoint[] {
    const count = Math.floor((minutes * MINUTE_MS) / SAMPLE_INTERVAL_MS) + 1;
    return Array.from({ length: count }, (_value, index) => {
        const elapsedMs = index * SAMPLE_INTERVAL_MS;
        return {
            atEpochMs: WINDOW_STARTED_AT_EPOCH_MS + elapsedMs,
            agentId: null,
            value: valueAt(elapsedMs / MINUTE_MS)
        };
    });
}

function toSamples(overrides: Partial<V1dGrowthSamples>): V1dGrowthSamples {
    return {
        postgres: [],
        'admin-system': [],
        'admin-queues': [],
        'admin-realtime': [],
        'api-heap': [],
        'process-rss': [],
        'browser-stats': [],
        ...overrides
    };
}

function toPostgresTable(value: number): ApiJsonValue {
    return { tables: { surface_under_test: value } };
}

function toSurface(
    classification: V1dGrowthClassification,
    reader: V1dGrowthReader = POSTGRES_READER
): V1dGrowthSurface {
    return { id: 1, name: 'surface under test', owner: 'test', classification, readers: [reader] };
}

function computeSingleRow(surface: V1dGrowthSurface, samples: V1dGrowthSamples): V1dGrowthVerdictRow {
    const verdict = computeV1dGrowthVerdict({
        surveyedSurfaceIds: [surface.id],
        surfaces: [surface],
        run: COMPLETED_RUN,
        samples
    });
    expect(verdict.rows).toHaveLength(1);
    return verdict.rows[0]!;
}

const PRINCIPALS: V1dGrowthReader = {
    source: 'postgres',
    path: ['tables', 'principals'],
    absent: 'zero',
    neverExpiringPath: null
};
const DURABLE: V1dGrowthClassification = {
    growthClass: 'durable',
    entity: 'principals',
    entityReader: PRINCIPALS,
    rowsPerEntity: 5
};

const TTL_WITHIN_RUN: V1dGrowthClassification = { growthClass: 'ttl-within-run', ttlMs: 10 * MINUTE_MS, sweepMs: MINUTE_MS };

describe('V1d growth verdict', () => {
    it('passes a TTL surface that plateaus after its time-to-live and one sweep', () => {
        const plateau = (minute: number) => toPostgresTable(Math.round(Math.min(minute, 11) * 100));
        const row = computeSingleRow(toSurface(TTL_WITHIN_RUN), toSamples({ postgres: toPoints(30, plateau) }));

        expect(row.outcome).toBe('pass');
        expect(row.firstPlateau).toEqual({ atElapsedMs: 11 * MINUTE_MS, value: 1_100 });
        expect(row.max).toBe(1_100);
        expect(row.slopePerHour).toBe(0);
    });

    it('fails a TTL surface that keeps growing linearly after its time-to-live', () => {
        const linear = (minute: number) => toPostgresTable(Math.round(minute * 100));
        const row = computeSingleRow(toSurface(TTL_WITHIN_RUN), toSamples({ postgres: toPoints(30, linear) }));

        expect(row.outcome).toBe('fail');
        expect(row.slopePerHour).toBeCloseTo(6_000, 0);
    });

    it('reports a TTL surface as insufficient when the run ends before a slope window after its time-to-live', () => {
        const plateau = (minute: number) => toPostgresTable(Math.round(Math.min(minute, 11) * 100));
        const row = computeSingleRow(toSurface(TTL_WITHIN_RUN), toSamples({ postgres: toPoints(15, plateau) }));

        expect(row.outcome).toBe('insufficient');
    });

    it('passes a count-capped surface at its cap and fails it one above', () => {
        const capped: V1dGrowthClassification = { growthClass: 'count-capped', cap: 256 };
        const atCap = (minute: number) => toPostgresTable(Math.min(256, Math.round(minute * 40)));
        const overCap = (minute: number) => toPostgresTable(minute === 20 ? 257 : Math.min(256, Math.round(minute * 40)));

        expect(computeSingleRow(toSurface(capped), toSamples({ postgres: toPoints(30, atCap) })).outcome).toBe('pass');
        const failed = computeSingleRow(toSurface(capped), toSamples({ postgres: toPoints(30, overCap) }));
        expect(failed.outcome).toBe('fail');
        expect(failed.max).toBe(257);
    });

    it('passes a durable surface whose growth stays within its new entities and reports the hourly growth', () => {
        const withEntities = (minute: number) => ({
            tables: { surface_under_test: Math.round(minute * 50), principals: Math.round(minute * 10) }
        });
        const row = computeSingleRow(toSurface(DURABLE), toSamples({ postgres: toPoints(75, withEntities) }));

        expect(row.outcome).toBe('pass');
        expect(row.slopePerHour).toBeCloseTo(3_000, 0);
        expect(row.bound).toContain('≤ 5 per new principals');
    });

    it('fails a durable surface that grows beyond its new entities', () => {
        const withoutEntities = (minute: number) => ({
            tables: { surface_under_test: Math.round(minute * 50), principals: 10 }
        });
        const row = computeSingleRow(toSurface(DURABLE), toSamples({ postgres: toPoints(75, withoutEntities) }));

        expect(row.outcome).toBe('fail');
        expect(row.reason).toContain('beyond');
    });

    it('declares an accepted append-only history: reports its growth, counts it apart from passes, fails nothing', () => {
        const history: V1dGrowthClassification = {
            growthClass: 'declared-append-only',
            history: 'one event per state mutation'
        };
        const linear = (minute: number) => toPostgresTable(Math.round(minute * 10));
        const verdict = computeV1dGrowthVerdict({
            surveyedSurfaceIds: [1],
            surfaces: [toSurface(history)],
            run: COMPLETED_RUN,
            samples: toSamples({ postgres: toPoints(75, linear) })
        });

        expect(verdict.passed).toBe(true);
        expect(verdict.rows[0]).toMatchObject({ outcome: 'declared', growthClass: 'declared-append-only' });
        expect(verdict.rows[0]?.bound).toContain('+600/h');
        expect(verdict.rows[0]?.bound).toContain('+14400/day');
    });

    it('passes a TTL-beyond-run surface growing linearly and reports its projected bound', () => {
        const beyondRun: V1dGrowthClassification = { growthClass: 'ttl-beyond-run', ttlMs: 24 * 60 * MINUTE_MS };
        const linear = (minute: number) => toPostgresTable(Math.round(minute * 10));
        const row = computeSingleRow(toSurface(beyondRun), toSamples({ postgres: toPoints(75, linear) }));

        expect(row.outcome).toBe('pass');
        expect(row.bound).toContain('14400');
    });

    it('passes a flat heap after its warm-up', () => {
        const flat = (minute: number) => ({ heapUsed: 60 * MIB + (Math.round(minute * 2) % 2 === 0 ? 0 : MIB) });
        const row = computeSingleRow(
            toSurface({ growthClass: 'heap' }, HEAP_READER),
            toSamples({ 'api-heap': toPoints(75, flat) })
        );

        expect(row.outcome).toBe('pass');
        expect(Math.abs(row.slopePerHour ?? Number.POSITIVE_INFINITY)).toBeLessThan(10 * MIB);
    });

    it('fails a heap that climbs faster than the hourly limit after its warm-up', () => {
        const climbing = (minute: number) => ({ heapUsed: 60 * MIB + Math.round(minute * MIB) });
        const row = computeSingleRow(
            toSurface({ growthClass: 'heap' }, HEAP_READER),
            toSamples({ 'api-heap': toPoints(75, climbing) })
        );

        expect(row.outcome).toBe('fail');
        expect(row.slopePerHour).toBeCloseTo(60 * MIB, -3);
    });

    it('fails a heap that doubles its first plateau even when the late slope is flat', () => {
        const stepped = (minute: number) => ({ heapUsed: minute < 40 ? 60 * MIB : 130 * MIB });
        const row = computeSingleRow(
            toSurface({ growthClass: 'heap' }, HEAP_READER),
            toSamples({ 'api-heap': toPoints(75, stepped) })
        );

        expect(row.outcome).toBe('fail');
        expect(row.firstPlateau?.value).toBe(60 * MIB);
    });

    it('fails a surveyed surface without a class, and the whole verdict with it', () => {
        const linear = (minute: number) => toPostgresTable(Math.round(minute * 10));
        const verdict = computeV1dGrowthVerdict({
            surveyedSurfaceIds: [1, 2],
            surfaces: [toSurface({ growthClass: 'count-capped', cap: 1_000 })],
            run: COMPLETED_RUN,
            samples: toSamples({ postgres: toPoints(75, linear) })
        });

        expect(verdict.passed).toBe(false);
        expect(verdict.rows.find((row) => row.surfaceId === 2)).toMatchObject({
            growthClass: 'unclassified',
            outcome: 'unclassified'
        });
    });

    it('fails a runtime-state namespace the samples hold but no surface reads', () => {
        const reader: V1dGrowthReader = {
            source: 'postgres',
            path: ['runtimeState', 'byNamespace', 'known'],
            absent: 'zero',
            neverExpiringPath: null
        };
        const verdict = computeV1dGrowthVerdict({
            surveyedSurfaceIds: [1],
            surfaces: [toSurface({ growthClass: 'count-capped', cap: 10 }, reader)],
            run: COMPLETED_RUN,
            samples: toSamples({
                postgres: toPoints(5, () => ({ runtimeState: { byNamespace: { known: 3, unlisted: 4 } } }))
            })
        });

        expect(verdict.passed).toBe(false);
        expect(verdict.rows.map((row) => [row.surface, row.outcome])).toEqual([
            ['surface under test', 'pass'],
            ['runtime_state_store namespace unlisted', 'unclassified']
        ]);
    });

    it('reads a missing count-map key as zero and a missing admin reading as no data', () => {
        const postgres = computeSingleRow(
            toSurface({ growthClass: 'count-capped', cap: 0 }),
            toSamples({ postgres: toPoints(5, () => ({ tables: {} })) })
        );
        const admin = computeSingleRow(
            toSurface({ growthClass: 'count-capped', cap: 512 }, {
                source: 'admin-realtime',
                path: ['caches', 'groupAudienceSnapshots'],
                absent: 'no-reading',
                neverExpiringPath: null
            }),
            toSamples({ 'admin-realtime': toPoints(5, () => ({ caches: {} })) })
        );

        expect(postgres).toMatchObject({ outcome: 'pass', max: 0 });
        expect(admin).toMatchObject({ outcome: 'no-data', max: null });
    });

    it('takes the largest agent reading in each sample interval for a browser surface', () => {
        const reader: V1dGrowthReader = {
            source: 'browser-stats',
            path: ['rallar', 'alm', 'orderingTracks'],
            absent: 'no-reading',
            neverExpiringPath: null
        };
        const points: readonly V1dGrowthSamplePoint[] = [
            { atEpochMs: WINDOW_STARTED_AT_EPOCH_MS + 1_000, agentId: 'controller-01', value: toTracks(10) },
            { atEpochMs: WINDOW_STARTED_AT_EPOCH_MS + 2_000, agentId: 'controller-02', value: toTracks(40) },
            { atEpochMs: WINDOW_STARTED_AT_EPOCH_MS + 31_000, agentId: 'controller-01', value: toTracks(12) },
            { atEpochMs: WINDOW_STARTED_AT_EPOCH_MS + 32_000, agentId: 'controller-02', value: {} }
        ];
        const row = computeSingleRow(
            toSurface({ growthClass: 'count-capped', cap: 512 }, reader),
            toSamples({ 'browser-stats': points })
        );

        expect(row).toMatchObject({ outcome: 'pass', max: 40 });
    });

    it('fails a TTL surface whose rows stamped never to expire rise, and passes it while they hold', () => {
        const beyondRun: V1dGrowthClassification = { growthClass: 'ttl-beyond-run', ttlMs: 24 * 60 * MINUTE_MS };
        const reader: V1dGrowthReader = {
            source: 'postgres',
            path: ['runtimeState', 'byNamespace', 'outbox-proofs'],
            absent: 'zero',
            neverExpiringPath: ['runtimeState', 'neverExpireByNamespace', 'outbox-proofs']
        };
        const toProofs = (rows: number, neverExpiring: number): ApiJsonValue => ({
            runtimeState: {
                byNamespace: { 'outbox-proofs': rows },
                neverExpireByNamespace: { 'outbox-proofs': neverExpiring }
            }
        });
        const rising = (minute: number) => toProofs(Math.round(minute * 10), Math.round(minute * 10));
        const held = (minute: number) => toProofs(Math.round(minute * 10), 3);

        const failed = computeSingleRow(toSurface(beyondRun, reader), toSamples({ postgres: toPoints(75, rising) }));
        expect(failed.outcome).toBe('fail');
        expect(failed.reason).toContain('never to expire');
        expect(computeSingleRow(toSurface(beyondRun, reader), toSamples({ postgres: toPoints(75, held) })).outcome)
            .toBe('pass');
    });

    it('fails an unbounded surface whose readings rise during the run', () => {
        const unbounded: V1dGrowthClassification = { growthClass: 'unbounded', missingBound: 'rows never expire' };
        const rising = (minute: number) => toPostgresTable(Math.round(minute * 4));
        const row = computeSingleRow(toSurface(unbounded), toSamples({ postgres: toPoints(30, rising) }));

        expect(row).toMatchObject({ outcome: 'fail', max: 120 });
        expect(row.bound).toContain('rows never expire');
    });

    it('reports an unbounded surface that never grows as unexercised: a follow-up, neither a pass nor a fail', () => {
        const unbounded: V1dGrowthClassification = { growthClass: 'unbounded', missingBound: 'rows never expire' };
        const flat = () => toPostgresTable(0);
        const verdict = computeV1dGrowthVerdict({
            surveyedSurfaceIds: [1],
            surfaces: [toSurface(unbounded)],
            run: COMPLETED_RUN,
            samples: toSamples({ postgres: toPoints(30, flat) })
        });

        expect(verdict.rows[0]).toMatchObject({ outcome: 'unbounded-unexercised', max: 0 });
        expect(verdict.passed).toBe(true);
        expect(verdict.followUps).toEqual(['1 surface under test (postgres tables.surface_under_test)']);
    });

    it('fails the verdict when the run recorded no workload outcome', () => {
        const verdict = computeV1dGrowthVerdict({
            surveyedSurfaceIds: [],
            surfaces: [],
            run: { windowStartedAtEpochMs: WINDOW_STARTED_AT_EPOCH_MS, workload: null },
            samples: toSamples({})
        });

        expect(verdict.passed).toBe(false);
        expect(verdict.workloadIssues).toEqual(['the run recorded no workload outcome']);
    });

    it('fails the verdict when the manifest did not pass or a churn iteration failed, naming the iterations', () => {
        const verdict = computeV1dGrowthVerdict({
            surveyedSurfaceIds: [],
            surfaces: [],
            run: {
                windowStartedAtEpochMs: WINDOW_STARTED_AT_EPOCH_MS,
                workload: {
                    ...COMPLETED_RUN.workload!,
                    runner: 'outlasted-window',
                    churnFailedRunIds: ['churn-007', 'churn-012']
                }
            },
            samples: toSamples({})
        });

        expect(verdict.passed).toBe(false);
        expect(verdict.workloadIssues).toEqual([
            'the manifest runner ended outlasted-window, not passed',
            'churn iterations failed: churn-007, churn-012'
        ]);
    });

    it('fails the verdict when no churn iteration passed', () => {
        const verdict = computeV1dGrowthVerdict({
            surveyedSurfaceIds: [],
            surfaces: [],
            run: { windowStartedAtEpochMs: WINDOW_STARTED_AT_EPOCH_MS, workload: { ...COMPLETED_RUN.workload!, churnPassed: 0 } },
            samples: toSamples({})
        });

        expect(verdict.workloadIssues).toEqual(['no churn iteration passed']);
        expect(verdict.passed).toBe(false);
    });

    it('reads an array length step', () => {
        const reader: V1dGrowthReader = {
            source: 'admin-realtime',
            path: ['almReceipts', 'diagnostics', 'messages', 'length'],
            absent: 'no-reading',
            neverExpiringPath: null
        };
        const row = computeSingleRow(
            toSurface({ growthClass: 'count-capped', cap: 256 }, reader),
            toSamples({ 'admin-realtime': toPoints(5, () => ({ almReceipts: { diagnostics: { messages: [1, 2, 3] } } })) })
        );

        expect(row).toMatchObject({ outcome: 'pass', max: 3 });
    });
});

function toTracks(orderingTracks: number): ApiJsonValue {
    return { rallar: { alm: { orderingTracks } } };
}
