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
        manifestAgents: 15,
        eventHistoryMaxEvents: 10_000,
        groupCurrentSnapshotCacheMaxEntries: 32,
        apiProcesses: 2,
        churnStarted: 30,
        churnPassed: 30,
        churnFailedRunIds: []
    }
};
const MINUTE_MS = 60_000;
const SAMPLE_INTERVAL_MS = 30_000;
const MIB = 1_048_576;
const MB = 1_000_000;
const POSTGRES_READER: V1dGrowthReader = { source: 'postgres', path: ['tables', 'surface_under_test'], absent: 'zero', neverExpiringPath: null };
const HEAP_READER: V1dGrowthReader = { source: 'api-heap', path: ['heapUsed'], absent: 'no-reading', neverExpiringPath: null };
const PAGE_HEAP_READER: V1dGrowthReader = {
    source: 'browser-stats',
    path: ['browser', 'pageHeap', 'usedJSHeapSize'],
    absent: 'no-reading',
    neverExpiringPath: null
};

function toPoints(
    minutes: number,
    valueAt: (elapsedMinutes: number) => ApiJsonValue
): readonly V1dGrowthSamplePoint[] {
    return toReporterPoints({ agentId: null, serviceId: null }, minutes, valueAt);
}

function toReporterPoints(
    reporter: Pick<V1dGrowthSamplePoint, 'agentId' | 'serviceId'>,
    minutes: number,
    valueAt: (elapsedMinutes: number) => ApiJsonValue
): readonly V1dGrowthSamplePoint[] {
    const count = Math.floor((minutes * MINUTE_MS) / SAMPLE_INTERVAL_MS) + 1;
    return Array.from({ length: count }, (_value, index) => {
        const elapsedMs = index * SAMPLE_INTERVAL_MS;
        return {
            atEpochMs: WINDOW_STARTED_AT_EPOCH_MS + elapsedMs,
            ...reporter,
            value: valueAt(elapsedMs / MINUTE_MS)
        };
    });
}

/** Three agents whose page heaps follow `heapAt`, each a little apart from the others. */
function toPageHeapPoints(minutes: number, heapAt: (elapsedMinutes: number) => number): readonly V1dGrowthSamplePoint[] {
    return ['controller-01', 'controller-02', 'controller-03'].flatMap((agentId, agent) =>
        toReporterPoints(
            { agentId, serviceId: null },
            minutes,
            (minute) => ({ browser: { pageHeap: { usedJSHeapSize: heapAt(minute) + agent * MB } } })
        )
    );
}

/** One agent per entry, each reporting every 30 s for `minutes` along its own heap curve. */
function toAgentsPageHeapPoints(
    minutes: number,
    agents: ReadonlyArray<readonly [agentId: string, heapAt: (elapsedMinutes: number) => number, minutes?: number]>
): readonly V1dGrowthSamplePoint[] {
    return agents.flatMap(([agentId, heapAt, agentMinutes]) =>
        toReporterPoints(
            { agentId, serviceId: null },
            agentMinutes ?? minutes,
            (minute) => ({ browser: { pageHeap: { usedJSHeapSize: heapAt(minute) } } })
        )
    );
}

/** A GC sawtooth repeating every 2.5 minutes: four low readings, then one near the page's peak. */
function toSawtoothMb(minute: number): number {
    return [50, 55, 60, 65, 190][Math.round(minute * 2) % 5]! * MB;
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
    entityCount: { source: 'samples', reader: PRINCIPALS },
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

    it('fails a registered-account surface at a sample whose ceiling reading is missing, instead of passing it', () => {
        const registered: V1dGrowthClassification = {
            growthClass: 'durable',
            entity: 'accounts',
            entityCount: {
                source: 'registrations',
                principalsPerChurnIteration: 100,
                ceiling: { source: 'postgres', path: ['tables', 'ceiling'], absent: 'no-reading', neverExpiringPath: null }
            },
            rowsPerEntity: 1
        };
        const toValue = (minute: number) => ({
            tables: { surface_under_test: 100 + Math.round(minute), ...(minute === 10 ? {} : { ceiling: 10_000 }) }
        });
        const row = computeSingleRow(toSurface(registered), toSamples({ postgres: toPoints(20, toValue) }));

        expect(row.outcome).toBe('fail');
        expect(row.reason).toContain('no ceiling reading');
        expect(row.reason).toContain('10 min');
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

    // Rows that arrive when sessions close come in a late burst: the run rate stays near zero, so only an absolute
    // tolerance can tell that from an acceleration, and the projection takes the faster of the two rates.
    it('passes a TTL-beyond-run surface whose rows arrive late at under 60 an hour, projecting the late rate', () => {
        const beyondRun: V1dGrowthClassification = { growthClass: 'ttl-beyond-run', ttlMs: 720 * 60 * MINUTE_MS };
        const lateBurst = (minute: number) => toPostgresTable(131 + Math.round(Math.max(0, minute - 60) * 0.9));
        const row = computeSingleRow(toSurface(beyondRun), toSamples({ postgres: toPoints(75, lateBurst) }));

        expect(row.outcome).toBe('pass');
        expect(row.slopePerHour).toBeCloseTo(54, -1);
        expect(row.bound).toMatch(/^ttl 720 h; projected ≤ 3\d{4} \(max\(run, last 15 min\) rate × ttl\)$/);
    });

    it('fails a TTL-beyond-run surface that accelerates past 1.5 × its run rate + 60 an hour', () => {
        const beyondRun: V1dGrowthClassification = { growthClass: 'ttl-beyond-run', ttlMs: 24 * 60 * MINUTE_MS };
        const accelerating = (minute: number) => toPostgresTable(Math.round(minute * 2 + Math.max(0, minute - 60) * 10));
        const row = computeSingleRow(toSurface(beyondRun), toSamples({ postgres: toPoints(75, accelerating) }));

        expect(row.outcome).toBe('fail');
        expect(row.reason).toContain('accelerating');
        expect(row.bound).toContain(`projected ≤ ${Math.round(row.slopePerHour! * 24)}`);
    });

    it('never projects a TTL-beyond-run surface holding rows below the rows it holds', () => {
        const beyondRun: V1dGrowthClassification = { growthClass: 'ttl-beyond-run', ttlMs: 24 * 60 * MINUTE_MS };
        const falling = (minute: number) => toPostgresTable(Math.max(40, 300 - Math.round(minute * 10)));
        const row = computeSingleRow(toSurface(beyondRun), toSamples({ postgres: toPoints(75, falling) }));

        expect(row.outcome).toBe('pass');
        expect(row.bound).toContain('projected ≤ 300');
    });

    it('says a TTL-beyond-run surface sampled throughout without a row holds none, not a projection of 0', () => {
        const beyondRun: V1dGrowthClassification = { growthClass: 'ttl-beyond-run', ttlMs: 24 * 60 * MINUTE_MS };
        const row = computeSingleRow(toSurface(beyondRun), toSamples({ postgres: toPoints(75, () => toPostgresTable(0)) }));

        expect(row).toMatchObject({ outcome: 'pass', max: 0, bound: 'ttl 24 h; projected ≤ 0 (no rows held)' });
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

    it('judges each API process\'s heap on its own, and reports no data where no process sampled one', () => {
        const flat = (minute: number) => ({ heapUsed: 60 * MIB + (Math.round(minute * 2) % 2 === 0 ? 0 : MIB) });
        const climbing = (minute: number) => ({ heapUsed: 60 * MIB + Math.round(minute * MIB) });
        const heapSurface = toSurface({ growthClass: 'heap' }, HEAP_READER);
        const verdict = computeV1dGrowthVerdict({
            surveyedSurfaceIds: [1],
            surfaces: [heapSurface],
            run: COMPLETED_RUN,
            samples: toSamples({
                'api-heap': [
                    ...toReporterPoints({ agentId: null, serviceId: 'server-a' }, 75, flat),
                    ...toReporterPoints({ agentId: null, serviceId: 'server-b' }, 75, climbing)
                ]
            })
        });

        expect(verdict.rows.map((row) => [row.reader, row.outcome])).toEqual([
            ['api-heap heapUsed server-a', 'pass'],
            ['api-heap heapUsed server-b', 'fail']
        ]);
        expect(computeSingleRow(heapSurface, toSamples({}))).toMatchObject({
            reader: 'api-heap heapUsed',
            outcome: 'no-data'
        });
    });

    it('reports a missing API process\'s heap as a no-data row of its own, from the process count the run recorded', () => {
        const flat = (minute: number) => ({ heapUsed: 60 * MIB + (Math.round(minute * 2) % 2 === 0 ? 0 : MIB) });
        const verdict = computeV1dGrowthVerdict({
            surveyedSurfaceIds: [1],
            surfaces: [toSurface({ growthClass: 'heap' }, HEAP_READER)],
            run: { ...COMPLETED_RUN, workload: { ...COMPLETED_RUN.workload!, apiProcesses: 3 } },
            samples: toSamples({
                'api-heap': [
                    ...toReporterPoints({ agentId: null, serviceId: 'server-a' }, 75, flat),
                    ...toReporterPoints({ agentId: null, serviceId: 'server-b' }, 75, flat)
                ]
            })
        });

        expect(verdict.rows.map((row) => [row.reader, row.outcome])).toEqual([
            ['api-heap heapUsed server-a', 'pass'],
            ['api-heap heapUsed server-b', 'pass'],
            ['api-heap heapUsed unreported process 1', 'no-data']
        ]);
        expect(verdict.passed).toBe(false);
    });

    it('passes a page heap whose GC sawtooth swings wide around flat 5-minute medians, and reports its raw peak', () => {
        const row = computeSingleRow(
            toSurface({ growthClass: 'heap' }, PAGE_HEAP_READER),
            toSamples({ 'browser-stats': toPageHeapPoints(75, toSawtoothMb) })
        );

        expect(row.outcome).toBe('pass');
        expect(row.firstPlateau).toEqual({ atElapsedMs: 10 * MINUTE_MS, value: 60 * MB });
        expect(row.slopePerHour).toBe(0);
        expect(row.max).toBe(192 * MB);
        expect(row.bound).toContain('5-minute bucket medians');
        expect(row.bound).toContain('product structures + the bounded black-box event history');
    });

    it('fails a page heap whose 5-minute medians rise 20 MB an hour under the sawtooth', () => {
        const rising = (minute: number) => toSawtoothMb(minute) + Math.round((minute / 60) * 20 * MB);
        const row = computeSingleRow(
            toSurface({ growthClass: 'heap' }, PAGE_HEAP_READER),
            toSamples({ 'browser-stats': toPageHeapPoints(75, rising) })
        );

        expect(row.outcome).toBe('fail');
        expect(row.slopePerHour).toBeCloseTo(20 * MB, -5);
        expect(row.reason).toContain('bucket median');
    });

    it('fails the page heap row when one of three agents climbs 20 MB an hour, and names that agent', () => {
        const rising = (minute: number) => toSawtoothMb(minute) + Math.round((minute / 60) * 20 * MB);
        const row = computeSingleRow(
            toSurface({ growthClass: 'heap' }, PAGE_HEAP_READER),
            toSamples({
                'browser-stats': toAgentsPageHeapPoints(75, [
                    ['controller-01', toSawtoothMb],
                    ['controller-02', toSawtoothMb],
                    ['controller-03', rising]
                ])
            })
        );

        expect(row.outcome).toBe('fail');
        expect(row.slopePerHour).toBeCloseTo(20 * MB, -5);
        expect(row.reason).toContain('controller-03');
        expect(row.reason).not.toContain('controller-01');
    });

    it('passes the page heap row only when every agent is flat, and judges no cross-agent median', () => {
        const flatAt = (megabytes: number) => () => megabytes * MB;
        const row = computeSingleRow(
            toSurface({ growthClass: 'heap' }, PAGE_HEAP_READER),
            toSamples({
                'browser-stats': toAgentsPageHeapPoints(75, [
                    ['controller-01', flatAt(40)],
                    ['controller-02', flatAt(80)],
                    ['controller-03', flatAt(120)]
                ])
            })
        );

        expect(row.outcome).toBe('pass');
        expect(row.max).toBe(120 * MB);
    });

    it('reports the page heap row as insufficient, not passed, when one agent has fewer than three complete buckets', () => {
        const flat = () => 60 * MB;
        const row = computeSingleRow(
            toSurface({ growthClass: 'heap' }, PAGE_HEAP_READER),
            toSamples({
                'browser-stats': toAgentsPageHeapPoints(75, [
                    ['controller-01', flat],
                    ['controller-02', flat],
                    ['controller-03', flat, 19]
                ])
            })
        );

        expect(row.outcome).toBe('insufficient');
        expect(row.reason).toContain('controller-03');
        expect(row.reason).toContain('3 complete 5-minute buckets');
    });

    it('judges an agent that fell silent after minute 9 as insufficient, never leaving it out of the row', () => {
        const flat = () => 60 * MB;
        const row = computeSingleRow(
            toSurface({ growthClass: 'heap' }, PAGE_HEAP_READER),
            toSamples({
                'browser-stats': toAgentsPageHeapPoints(75, [
                    ['controller-01', flat],
                    ['controller-02', flat],
                    ['controller-03', flat, 9]
                ])
            })
        );

        expect(row.outcome).toBe('insufficient');
        expect(row.reason).toContain('controller-03');
        expect(row.reason).not.toContain('controller-01');
    });

    it('bounds each agent\'s complete buckets by its own last reading, so one reading in a third bucket is not a bucket', () => {
        const flat = () => 60 * MB;
        const row = computeSingleRow(
            toSurface({ growthClass: 'heap' }, PAGE_HEAP_READER),
            toSamples({
                'browser-stats': toAgentsPageHeapPoints(75, [
                    ['controller-01', flat],
                    ['controller-02', flat],
                    ['controller-03', flat, 20]
                ])
            })
        );

        expect(row.outcome).toBe('insufficient');
        expect(row.reason).toContain('controller-03');
    });

    it('reports every agent insufficient, without throwing, when all readings predate the warm-up', () => {
        const flat = () => 60 * MB;
        const row = computeSingleRow(
            toSurface({ growthClass: 'heap' }, PAGE_HEAP_READER),
            toSamples({
                'browser-stats': toAgentsPageHeapPoints(9, [['controller-01', flat], ['controller-02', flat]])
            })
        );

        expect(row.outcome).toBe('insufficient');
        expect(row.reason).toContain('controller-01');
        expect(row.reason).toContain('controller-02');
    });

    it('does not name a surface number in the page heap bound', () => {
        const row = computeSingleRow(toSurface({ growthClass: 'heap' }, PAGE_HEAP_READER), toSamples({}));

        expect(row.bound).not.toMatch(/surface \d+/u);
        expect(row.bound).toContain('black-box event history');
    });

    it('reports a page heap no agent sampled as no data against its 5-minute bucket medians', () => {
        const row = computeSingleRow(toSurface({ growthClass: 'heap' }, PAGE_HEAP_READER), toSamples({}));

        expect(row.outcome).toBe('no-data');
        expect(row.bound).toContain('5-minute bucket medians');
        expect(row.bound).toContain('product structures + the bounded black-box event history');
    });

    it('reports a page heap as insufficient with fewer than three complete 5-minute buckets after its warm-up', () => {
        const row = computeSingleRow(
            toSurface({ growthClass: 'heap' }, PAGE_HEAP_READER),
            toSamples({ 'browser-stats': toPageHeapPoints(24, toSawtoothMb) })
        );

        expect(row.outcome).toBe('insufficient');
        expect(row.reason).toContain('3 complete 5-minute buckets');
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
            { atEpochMs: WINDOW_STARTED_AT_EPOCH_MS + 1_000, agentId: 'controller-01', serviceId: null, value: toTracks(10) },
            { atEpochMs: WINDOW_STARTED_AT_EPOCH_MS + 2_000, agentId: 'controller-02', serviceId: null, value: toTracks(40) },
            { atEpochMs: WINDOW_STARTED_AT_EPOCH_MS + 31_000, agentId: 'controller-01', serviceId: null, value: toTracks(12) },
            { atEpochMs: WINDOW_STARTED_AT_EPOCH_MS + 32_000, agentId: 'controller-02', serviceId: null, value: {} }
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
        const flat = () => toPostgresTable(3);
        const verdict = computeV1dGrowthVerdict({
            surveyedSurfaceIds: [1],
            surfaces: [toSurface(unbounded)],
            run: COMPLETED_RUN,
            samples: toSamples({ postgres: toPoints(30, flat) })
        });

        expect(verdict.rows[0]).toMatchObject({ outcome: 'unbounded-unexercised', max: 3 });
        expect(verdict.passed).toBe(true);
        expect(verdict.followUps).toEqual(['1 surface under test (postgres tables.surface_under_test) held at 3']);
    });

    it('reports an unbounded surface that starts high and falls as unexercised, never a pass', () => {
        const unbounded: V1dGrowthClassification = { growthClass: 'unbounded', missingBound: 'rows never expire' };
        const falling = (minute: number) => toPostgresTable(Math.max(5, 40 - Math.round(minute)));
        const verdict = computeV1dGrowthVerdict({
            surveyedSurfaceIds: [1],
            surfaces: [toSurface(unbounded)],
            run: COMPLETED_RUN,
            samples: toSamples({ postgres: toPoints(30, falling) })
        });

        expect(verdict.rows[0]).toMatchObject({ outcome: 'unbounded-unexercised', max: 40 });
        expect(verdict.rows[0]?.outcome).not.toBe('pass');
        expect(verdict.followUps).toEqual(['1 surface under test (postgres tables.surface_under_test) held at 40']);
    });

    // The unbounded predicate compares each reading to the first one only: a regrowth that stays below the first
    // reading is not a rise.
    it('reports an unbounded surface that starts high, drops and regrows below its first reading as unexercised', () => {
        const unbounded: V1dGrowthClassification = { growthClass: 'unbounded', missingBound: 'rows never expire' };
        const dropsAndRegrows = (minute: number) => toPostgresTable(minute < 10 ? 40 - minute * 3 : 10 + Math.round(minute));
        const verdict = computeV1dGrowthVerdict({
            surveyedSurfaceIds: [1],
            surfaces: [toSurface(unbounded)],
            run: COMPLETED_RUN,
            samples: toSamples({ postgres: toPoints(25, dropsAndRegrows) })
        });

        expect(verdict.rows[0]).toMatchObject({ outcome: 'unbounded-unexercised', max: 40 });
    });

    it('fails an unbounded surface that rises and then falls back', () => {
        const unbounded: V1dGrowthClassification = { growthClass: 'unbounded', missingBound: 'rows never expire' };
        const risesThenFalls = (minute: number) => toPostgresTable(minute < 15 ? Math.round(minute) : 1);
        const row = computeSingleRow(toSurface(unbounded), toSamples({ postgres: toPoints(30, risesThenFalls) }));

        expect(row).toMatchObject({ outcome: 'fail', max: 15 });
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
