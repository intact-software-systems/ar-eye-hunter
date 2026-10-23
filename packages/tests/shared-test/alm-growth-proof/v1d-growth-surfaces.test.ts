import {
    describe,
    expect,
    it
} from 'vitest';

import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import {
    V1D_GROWTH_SURFACES,
    V1D_GROWTH_SURVEY_SURFACE_IDS
} from '../../../shared-test/rallar-bb-test/alm/growth-proof/v1d-growth-surfaces.ts';
import { computeV1dGrowthVerdict } from '../../../shared-test/rallar-bb-test/alm/growth-proof/v1d-growth-verdict.ts';

describe('V1d growth surface classification', () => {
    it('classifies every surface of the growth survey, each with at least one reader', () => {
        const ids = V1D_GROWTH_SURFACES.map((surface) => surface.id);
        const names = V1D_GROWTH_SURFACES.map((surface) => surface.name);

        expect(new Set(names).size).toBe(names.length);
        expect(V1D_GROWTH_SURVEY_SURFACE_IDS).toHaveLength(75);
        expect(V1D_GROWTH_SURVEY_SURFACE_IDS.filter((id) => !ids.includes(id))).toEqual([]);
        expect(V1D_GROWTH_SURFACES.filter((surface) => surface.readers.length === 0)).toEqual([]);
    });

    it('keeps each runtime-state namespace with one surface, so a namespace has one class', () => {
        const namespaces = V1D_GROWTH_SURFACES.flatMap((surface) =>
            surface.readers
                .filter((reader) => reader.source === 'postgres' && reader.path[1] === 'byNamespace')
                .map((reader) => reader.path[2])
        );

        expect(new Set(namespaces).size).toBe(namespaces.length);
    });

    it('guards the resource_inbox total against rows stamped never to expire', () => {
        const total = V1D_GROWTH_SURFACES.find((surface) => surface.id === 1);

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
        const total = V1D_GROWTH_SURFACES.find((surface) => surface.id === 1)!;
        const windowStartedAtEpochMs = 1_800_000_000_000;
        const toSamples = (settledAt: (sample: number) => number) =>
            Array.from({ length: 151 }, (_value, sample) => ({
                atEpochMs: windowStartedAtEpochMs + sample * 30_000,
                agentId: null,
                value: {
                    resourceInbox: {
                        total: 1_000 + sample * 10,
                        neverExpire: (sample % 4) * 4 + settledAt(sample),
                        neverExpireSettled: settledAt(sample)
                    }
                } satisfies ApiJsonValue
            }));
        const computeOutcome = (settledAt: (sample: number) => number) =>
            computeV1dGrowthVerdict({
                surveyedSurfaceIds: [1],
                surfaces: [total],
                run: {
                    windowStartedAtEpochMs,
                    workload: {
                        runner: 'passed',
                        manifestStartedAtEpochMs: windowStartedAtEpochMs,
                        manifestCompletedAtEpochMs: windowStartedAtEpochMs + 4_500_000,
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

    it('bounds a page\'s delivered markers at 256 per inbound store across its two stores', () => {
        const markers = V1D_GROWTH_SURFACES.find((surface) => surface.id === 49);

        expect(markers?.classification).toEqual({ growthClass: 'count-capped', cap: 512 });
    });

    it('bounds the topology idempotency records by the 24-hour finished retention, guarded against rows without expiry', () => {
        const configMutations = V1D_GROWTH_SURFACES.find((surface) => surface.readers.some((reader) => reader.path.includes('group-topology:config-mutation')));

        expect(configMutations?.classification).toEqual({ growthClass: 'ttl-beyond-run', ttlMs: 86_400_000 });
        expect(configMutations?.readers[0]?.neverExpiringPath).toEqual([
            'runtimeState',
            'neverExpireByNamespace',
            'group-topology:config-mutation'
        ]);
    });
});
