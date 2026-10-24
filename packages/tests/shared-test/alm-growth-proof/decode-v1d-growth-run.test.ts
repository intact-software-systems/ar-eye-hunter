import {
    describe,
    expect,
    it
} from 'vitest';

import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import {
    decodeV1dGrowthRun,
    type V1dGrowthRunFiles
} from '../../../shared-test/rallar-bb-test/alm/growth-proof/decode-v1d-growth-run.ts';
import { V1D_GROWTH_SURFACES } from '../../../shared-test/rallar-bb-test/alm/growth-proof/v1d-growth-surfaces.ts';
import { computeV1dGrowthVerdict } from '../../../shared-test/rallar-bb-test/alm/growth-proof/v1d-growth-verdict.ts';

const STARTED_AT_EPOCH_MS = 1_800_000_000_000;

function toFiles(overrides: Partial<V1dGrowthRunFiles>): V1dGrowthRunFiles {
    return {
        runJson: JSON.stringify({ windowStartedAtEpochMs: STARTED_AT_EPOCH_MS }),
        postgres: '',
        adminSystem: '',
        adminQueues: '',
        adminRealtime: '',
        processRss: '',
        controlRun: '',
        apiHeap: '',
        ...overrides
    };
}

const PAGE_HEAP = {
    usedJSHeapSize: 20_000_000,
    totalJSHeapSize: 30_000_000,
    jsHeapSizeLimit: 4_000_000_000,
    forcedGc: true
};

function toHeapSampleLine(serviceId: string, atEpochMs: number, forcedGc: boolean): string {
    return JSON.stringify({
        component: 'api-process',
        operation: 'heap-sample',
        serviceId,
        details: { heapUsed: 62_914_560, forcedGc },
        type: 'rallar.timing',
        status: 'ok',
        durationMs: 30_000,
        atEpochMs
    });
}

function toStatsEnvelope(agentId: string, atEpochMs: number, payload: ApiJsonValue): ApiJsonValue {
    return { kind: 'stats', agentId, atEpochMs, payload: { kind: 'stats', atEpochMs, payload } };
}

describe('V1d growth run decoding', () => {
    it('reads the window start, and no workload while the script has not recorded one', () => {
        const decoded = decodeV1dGrowthRun(toFiles({}));

        expect(decoded.right?.run).toEqual({ windowStartedAtEpochMs: STARTED_AT_EPOCH_MS, workload: null });
        expect(decodeV1dGrowthRun(toFiles({ runJson: '{}' })).left).toEqual([
            'run.json windowStartedAtEpochMs is not a time'
        ]);
    });

    it('reads the workload outcome the script recorded at the end of the window', () => {
        const workload = {
            runner: 'outlasted-window',
            manifestStartedAtEpochMs: STARTED_AT_EPOCH_MS + 20_000,
            manifestCompletedAtEpochMs: null,
            manifestAgents: 15,
            eventHistoryMaxEvents: 10_000,
            groupCurrentSnapshotCacheMaxEntries: 32,
            apiProcesses: 3,
            churnStarted: 3,
            churnPassed: 1,
            churnFailedRunIds: ['churn-002']
        };
        const { churnStarted: _churnStarted, ...withoutIterationsStarted } = workload;
        const { eventHistoryMaxEvents: _eventHistoryMaxEvents, ...withoutEventHistoryBound } = workload;
        const { groupCurrentSnapshotCacheMaxEntries: _cacheCap, ...withoutCacheCap } = workload;
        const toLeft = (recorded: ApiJsonValue) =>
            decodeV1dGrowthRun(toFiles({
                runJson: JSON.stringify({ windowStartedAtEpochMs: STARTED_AT_EPOCH_MS, workload: recorded })
            })).left;

        expect(
            decodeV1dGrowthRun(toFiles({
                runJson: JSON.stringify({ windowStartedAtEpochMs: STARTED_AT_EPOCH_MS, workload })
            })).right?.run.workload
        ).toEqual(workload);
        expect(toLeft({ ...workload, runner: 'maybe' })).toEqual([
            'run.json workload is not a recorded runner outcome and churn count'
        ]);
        expect(toLeft(withoutIterationsStarted)).toEqual([
            'run.json workload is not a recorded runner outcome and churn count'
        ]);
        expect(toLeft(withoutEventHistoryBound)).toEqual([
            'run.json workload is not a recorded runner outcome and churn count'
        ]);
        const { apiProcesses: _apiProcesses, ...withoutApiProcesses } = workload;
        expect(toLeft(withoutApiProcesses)).toEqual([
            'run.json workload is not a recorded runner outcome and churn count'
        ]);
        expect(toLeft({ ...workload, eventHistoryMaxEvents: 0 })).toEqual([
            'run.json workload is not a recorded runner outcome and churn count'
        ]);
        expect(toLeft(withoutCacheCap)).toEqual([
            'run.json workload is not a recorded runner outcome and churn count'
        ]);
        expect(toLeft({ ...workload, groupCurrentSnapshotCacheMaxEntries: 0 })).toEqual([
            'run.json workload is not a recorded runner outcome and churn count'
        ]);
    });

    it('reads one sample per line and skips a line the sampler tore on its stop', () => {
        const postgres = [
            JSON.stringify({ atEpochMs: STARTED_AT_EPOCH_MS + 30_000, value: { tables: { crdt_updates: 0 } } }),
            '{"atEpochMs": 18000000'
        ].join('\n');
        const decoded = decodeV1dGrowthRun(toFiles({ postgres })).right;

        expect(decoded?.samples.postgres).toEqual([
            {
                atEpochMs: STARTED_AT_EPOCH_MS + 30_000,
                agentId: null,
                serviceId: null,
                value: { tables: { crdt_updates: 0 } }
            }
        ]);
        expect(decoded?.skippedLines).toBe(1);
    });

    it('reads each API process\'s heap samples with the process that took them', () => {
        const apiHeap = [
            toHeapSampleLine('server-a', STARTED_AT_EPOCH_MS + 60_000, true),
            toHeapSampleLine('server-b', STARTED_AT_EPOCH_MS + 61_000, true)
        ].join('\n');

        expect(decodeV1dGrowthRun(toFiles({ apiHeap })).right?.samples['api-heap']).toEqual([
            {
                atEpochMs: STARTED_AT_EPOCH_MS + 60_000,
                agentId: null,
                serviceId: 'server-a',
                value: { heapUsed: 62_914_560, forcedGc: true }
            },
            {
                atEpochMs: STARTED_AT_EPOCH_MS + 61_000,
                agentId: null,
                serviceId: 'server-b',
                value: { heapUsed: 62_914_560, forcedGc: true }
            }
        ]);
    });

    it('skips a heap sample taken without a forced collection', () => {
        const apiHeap = toHeapSampleLine('server-a', STARTED_AT_EPOCH_MS + 60_000, false);
        const decoded = decodeV1dGrowthRun(toFiles({ apiHeap })).right;

        expect(decoded?.samples['api-heap']).toEqual([]);
        expect(decoded?.skippedLines).toBe(1);
    });

    it('reads each agent stats snapshot once across overlapping polls and totals IndexedDB rows by family', () => {
        const census = {
            indexedDb: {
                databases: [
                    {
                        name: 'rallar-al-runtime:rallar-server:default',
                        version: 3,
                        stores: [{ name: 'entries', rows: 40 }, { name: 'alm-work', rows: 6 }]
                    }
                ],
                uncounted: []
            },
            pageHeap: PAGE_HEAP
        };
        const periodic = toStatsEnvelope('controller-02', STARTED_AT_EPOCH_MS + 5_000, {
            atEpochMs: STARTED_AT_EPOCH_MS + 5_000,
            browser: census
        });
        const ledger = toStatsEnvelope('controller-01', STARTED_AT_EPOCH_MS + 6_000, {
            atEpochMs: STARTED_AT_EPOCH_MS + 6_000,
            rallar: { alm: { orderingTracks: 3 } }
        });
        const poll = JSON.stringify({
            atEpochMs: STARTED_AT_EPOCH_MS + 30_000,
            value: { stats: [periodic], events: [ledger, { kind: 'event', agentId: 'controller-01', payload: {} }] }
        });
        const decoded = decodeV1dGrowthRun(toFiles({ controlRun: [poll, poll].join('\n') })).right;

        expect(decoded?.samples['browser-stats'].map(({ agentId, atEpochMs }) => [agentId, atEpochMs])).toEqual([
            ['controller-02', STARTED_AT_EPOCH_MS + 5_000],
            ['controller-01', STARTED_AT_EPOCH_MS + 6_000]
        ]);
        expect(decoded?.samples['browser-stats'][0]?.value).toMatchObject({
            browser: {
                pageHeap: { usedJSHeapSize: 20_000_000 },
                indexedDbRows: {
                    'rallar-al-runtime': 46,
                    'rallar-al-runtime/entries': 40,
                    'rallar-al-runtime/alm-work': 6
                }
            }
        });
    });

    it('drops a page heap read without a forced collection and keeps the rest of its census, so an all-unforced series reads no data', () => {
        const toCensusPoll = (forcedGc: boolean) =>
            JSON.stringify({
                atEpochMs: STARTED_AT_EPOCH_MS + 30_000,
                value: {
                    stats: [
                        toStatsEnvelope('controller-02', STARTED_AT_EPOCH_MS + 5_000, {
                            atEpochMs: STARTED_AT_EPOCH_MS + 5_000,
                            browser: {
                                indexedDb: { databases: [{ name: 'rallar-crdt', version: 1, stores: [{ name: 'seen', rows: 2 }] }], uncounted: [] },
                                pageHeap: { ...PAGE_HEAP, forcedGc }
                            }
                        })
                    ]
                }
            });
        const forced = decodeV1dGrowthRun(toFiles({ controlRun: toCensusPoll(true) })).right;
        const unforced = decodeV1dGrowthRun(toFiles({ controlRun: toCensusPoll(false) })).right;
        const pageHeapSurface = V1D_GROWTH_SURFACES.find((surface) =>
            surface.classification.growthClass === 'heap' && surface.readers[0]?.path.includes('pageHeap')
        )!;

        expect(forced?.samples['browser-stats'][0]?.value).toMatchObject({ browser: { pageHeap: { forcedGc: true } } });
        expect(unforced?.samples['browser-stats'][0]?.value).toMatchObject({
            browser: { indexedDbRows: { 'rallar-crdt': 2 } }
        });
        expect(unforced?.samples['browser-stats'][0]?.value).not.toHaveProperty('browser.pageHeap');
        expect(
            computeV1dGrowthVerdict({
                surveyedSurfaceIds: [pageHeapSurface.id],
                surfaces: [pageHeapSurface],
                run: unforced!.run,
                samples: unforced!.samples
            }).rows[0]?.outcome
        ).toBe('no-data');
    });

    it('counts each unforced page heap reading it drops once in the skipped lines, as it counts an unforced API sample', () => {
        const toPoll = (forcedGc: boolean) =>
            JSON.stringify({
                atEpochMs: STARTED_AT_EPOCH_MS + 30_000,
                value: {
                    stats: [
                        toStatsEnvelope('controller-02', STARTED_AT_EPOCH_MS + 5_000, {
                            atEpochMs: STARTED_AT_EPOCH_MS + 5_000,
                            browser: { pageHeap: { ...PAGE_HEAP, forcedGc } }
                        }),
                        toStatsEnvelope('controller-03', STARTED_AT_EPOCH_MS + 5_000, {
                            atEpochMs: STARTED_AT_EPOCH_MS + 5_000,
                            browser: { pageHeap: { ...PAGE_HEAP, forcedGc: true } }
                        })
                    ]
                }
            });
        const overlapping = [toPoll(false), toPoll(false)].join('\n');

        expect(decodeV1dGrowthRun(toFiles({ controlRun: overlapping })).right?.skippedLines).toBe(1);
        expect(decodeV1dGrowthRun(toFiles({ controlRun: toPoll(true) })).right?.skippedLines).toBe(0);
    });
});
