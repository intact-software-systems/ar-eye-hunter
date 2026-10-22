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
        apiTimingLog: '',
        ...overrides
    };
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
            churnPassed: 1,
            churnFailedRunIds: ['churn-002']
        };
        const decoded = decodeV1dGrowthRun(toFiles({
            runJson: JSON.stringify({ windowStartedAtEpochMs: STARTED_AT_EPOCH_MS, workload })
        }));

        expect(decoded.right?.run.workload).toEqual(workload);
        expect(
            decodeV1dGrowthRun(toFiles({
                runJson: JSON.stringify({ windowStartedAtEpochMs: STARTED_AT_EPOCH_MS, workload: { runner: 'maybe' } })
            })).left
        ).toEqual(['run.json workload is not a recorded runner outcome and churn count']);
    });

    it('reads one sample per line and skips a line the sampler tore on its stop', () => {
        const postgres = [
            JSON.stringify({ atEpochMs: STARTED_AT_EPOCH_MS + 30_000, value: { tables: { crdt_updates: 0 } } }),
            '{"atEpochMs": 18000000'
        ].join('\n');
        const decoded = decodeV1dGrowthRun(toFiles({ postgres })).right;

        expect(decoded?.samples.postgres).toEqual([
            { atEpochMs: STARTED_AT_EPOCH_MS + 30_000, agentId: null, value: { tables: { crdt_updates: 0 } } }
        ]);
        expect(decoded?.skippedLines).toBe(1);
    });

    it('reads the heap samples among the API timing lines', () => {
        const heapLine = {
            type: 'rallar.timing',
            component: 'api-process',
            operation: 'heap-sample',
            status: 'ok',
            durationMs: 30_000,
            atEpochMs: STARTED_AT_EPOCH_MS + 60_000,
            details: { heapUsed: 62_914_560, forcedGc: true }
        };
        const apiTimingLog = [
            'Listening on http://0.0.0.0:18780/',
            JSON.stringify({ type: 'rallar.timing', component: 'http', operation: 'GET /api/config', atEpochMs: 1 }),
            JSON.stringify(heapLine)
        ].join('\n');

        expect(decodeV1dGrowthRun(toFiles({ apiTimingLog })).right?.samples['api-heap']).toEqual([
            { atEpochMs: STARTED_AT_EPOCH_MS + 60_000, agentId: null, value: { heapUsed: 62_914_560, forcedGc: true } }
        ]);
    });

    it('skips a heap sample taken without a forced collection', () => {
        const apiTimingLog = JSON.stringify({
            type: 'rallar.timing',
            component: 'api-process',
            operation: 'heap-sample',
            atEpochMs: STARTED_AT_EPOCH_MS + 60_000,
            details: { heapUsed: 62_914_560, forcedGc: false }
        });
        const decoded = decodeV1dGrowthRun(toFiles({ apiTimingLog })).right;

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
            pageHeap: { usedJSHeapSize: 20_000_000, totalJSHeapSize: 30_000_000, jsHeapSizeLimit: 4_000_000_000 }
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
});
