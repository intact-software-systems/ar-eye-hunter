import {
    describe,
    expect,
    it
} from 'vitest';

import type { PSqlRows } from '@shared-server/postgres/p-sql-sql.ts';
import type { ResourceInboxRow } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';

import {
    topologyGroupSnapshot,
    type TopologyAppOutboxWorkerInput
} from '../../../rallar-system/topology/concurrency/postgres-topology-concurrency-fixtures.ts';
import { createLifecycleSql } from '../../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import {
    runTopologyAppOutboxWorkerProcess,
    type TopologyAppOutboxWorkerProcessInput
} from './postgres-topology-app-outbox-worker.ts';
import {
    waitForPostgresAppInboxWorkerParticipants,
    waitForPostgresWorkerBarrier
} from './postgres-worker-barrier.ts';

const WORKER_INPUT: TopologyAppOutboxWorkerInput = {
    groupSnapshot: topologyGroupSnapshot({ applicationId: 'worker-lifecycle', workspaceId: 'workspace', groupId: 'room' }),
    targetKey: { topicId: 'topology', contextId: 'room', resourceId: 'work-1' },
    atEpochMs: 1_700_000_000_000,
    traceFilePath: '/owned/trace.json',
    barrier: { readyDirectoryPath: '/owned/ready', releaseFilePath: '/owned/release' }
};

const COMPLETED_ROW: ResourceInboxRow = {
    ri_row_id: 17n,
    ri_resource_id: 'work-1',
    ri_topic_id: 'topology',
    ri_resource: 'completed-opaque-work',
    ri_type_id: 'RTC_TOPOLOGY_RECOMPUTE',
    ri_status: 'COMPLETED',
    fk_ext_bank_id: 'room',
    system_date: '2026-01-01',
    created_by: 'worker-lifecycle',
    created_ts: '2026-01-01 12:00:00.123456',
    expire_ts: '9999-12-31 23:59:59.999000',
    start_ts: '2026-01-01 12:00:01.123456',
    end_ts: '2026-01-01 12:00:02.123456',
    next_ts: null,
    ri_attempts: 2n
};

describe('topology APP_OUTBOX worker process ownership', () => {
    it('closes an acquired SQL client when its backend PID query rejects', async () => {
        const failure = new Error('PID query failed');
        const harness = createWorkerProcessHarness({ queryFailure: failure, failOnQuery: 1 });

        await expect(runTopologyAppOutboxWorkerProcess(harness.process)).rejects.toBe(failure);

        expect(harness.observations.closed).toBe(true);
        expect(harness.observations.traces).toEqual([]);
    });

    it('closes SQL when completed work trace persistence rejects', async () => {
        const failure = new Error('trace write failed');
        const harness = createWorkerProcessHarness({ traceFailure: failure });

        await expect(runTopologyAppOutboxWorkerProcess(harness.process)).rejects.toBe(failure);

        expect(harness.observations.closed).toBe(true);
        expect(harness.observations.traces.map(({ path, content }) => ({ path, trace: JSON.parse(content) }))).toEqual([
            { path: '/owned/trace.json', trace: { backendPid: 73, barrierWaitCount: 0 } }
        ]);
    });

    it('preserves the body failure while attempting trace persistence and SQL close', async () => {
        const bodyFailure = new Error('target read failed');
        const harness = createWorkerProcessHarness({
            queryFailure: bodyFailure,
            failOnQuery: 2,
            traceFailure: new Error('trace write failed'),
            closeFailure: new Error('close failed')
        });

        await expect(runTopologyAppOutboxWorkerProcess(harness.process)).rejects.toBe(bodyFailure);

        expect(harness.observations.closed).toBe(true);
        expect(harness.observations.traces).toHaveLength(1);
    });

    it('reports cleanup failure after successful work through the canonical client lifecycle', async () => {
        const closeFailure = new Error('close failed');
        const harness = createWorkerProcessHarness({ closeFailure });

        await expect(runTopologyAppOutboxWorkerProcess(harness.process)).rejects.toMatchObject({ errors: [closeFailure] });

        expect(harness.observations.closed).toBe(true);
        expect(harness.observations.traces).toHaveLength(1);
    });

    it('returns completed work and persists its real backend identity before releasing ownership', async () => {
        const harness = createWorkerProcessHarness({});

        await expect(runTopologyAppOutboxWorkerProcess(harness.process)).resolves.toEqual({ resourceId: 'work-1', status: 'COMPLETED', attemptCount: 2 });

        expect(harness.observations.closed).toBe(true);
        expect(harness.observations.traces.map(({ path, content }) => ({ path, trace: JSON.parse(content) }))).toEqual([
            { path: '/owned/trace.json', trace: { backendPid: 73, barrierWaitCount: 0 } }
        ]);
    });

    it.each([
        ['malformed JSON', '{'],
        ['null', 'null'],
        ['array', '[]'],
        ['missing fields', '{}'],
        ['invalid group domain', JSON.stringify({ ...WORKER_INPUT, groupSnapshot: { group: {} } })],
        ['empty key', JSON.stringify({ ...WORKER_INPUT, targetKey: { ...WORKER_INPUT.targetKey, resourceId: '' } })],
        ['fractional clock', JSON.stringify({ ...WORKER_INPUT, atEpochMs: 1.5 })],
        ['negative clock', JSON.stringify({ ...WORKER_INPUT, atEpochMs: -1 })],
        ['empty trace path', JSON.stringify({ ...WORKER_INPUT, traceFilePath: '' })],
        ['invalid barrier', JSON.stringify({ ...WORKER_INPUT, barrier: { readyDirectoryPath: [], releaseFilePath: '/release' } })]
    ])('refuses %s before acquiring or affecting SQL and trace storage', async (_caseName, rawInput) => {
        const harness = createWorkerProcessHarness({ rawInput });

        await expect(runTopologyAppOutboxWorkerProcess(harness.process)).rejects.toBeInstanceOf(Error);

        expect(harness.observations.acquired).toBe(false);
        expect(harness.observations.closed).toBe(false);
        expect(harness.observations.traces).toEqual([]);
    });

    it('signals the canonical barrier and completes only after its release artifact exists', async () => {
        const directory = await Deno.makeTempDir({ prefix: 'topology-worker-barrier-' });
        const barrier = { readyDirectoryPath: `${directory}/ready`, releaseFilePath: `${directory}/release` };
        let completed = false;
        const waiting = waitForPostgresWorkerBarrier(barrier, 'worker/1').then(() => {
            completed = true;
        });
        let hasPrimaryFailure = false;
        try {
            await waitForPostgresAppInboxWorkerParticipants(barrier.readyDirectoryPath, 1, [waiting]);
            expect(completed).toBe(false);
            await Deno.writeTextFile(barrier.releaseFilePath, 'release');
            await waiting;
            expect(completed).toBe(true);
        }
        catch (error) {
            hasPrimaryFailure = true;
            throw error;
        }
        finally {
            const releaseResults = await Promise.allSettled([
                Deno.writeTextFile(barrier.releaseFilePath, 'release'),
                waiting
            ]);
            const removeResults = await Promise.allSettled([Deno.remove(directory, { recursive: true })]);
            const failures = [...releaseResults, ...removeResults]
                .flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
            if (!hasPrimaryFailure && failures.length > 0) {
                throw new AggregateError(failures, 'Failed to release topology worker barrier test resources');
            }
        }
    });
});

interface WorkerProcessHarnessOptions {
    readonly rawInput?: string;
    readonly queryFailure?: Error;
    readonly failOnQuery?: number;
    readonly traceFailure?: Error;
    readonly closeFailure?: Error;
}

interface WorkerProcessHarness {
    readonly observations: WorkerProcessObservations;
    readonly process: TopologyAppOutboxWorkerProcessInput;
}

interface WorkerProcessObservations {
    acquired: boolean;
    closed: boolean;
    readonly traces: TraceWrite[];
}

interface TraceWrite {
    readonly path: string;
    readonly content: string;
}

function createWorkerProcessHarness(options: WorkerProcessHarnessOptions): WorkerProcessHarness {
    let queries = 0;
    const observations: WorkerProcessObservations = { acquired: false, closed: false, traces: [] };
    return {
        observations,
        process: {
            rawInput: options.rawInput ?? JSON.stringify(WORKER_INPUT),
            workerPid: 311,
            createSql: async () => {
                observations.acquired = true;
                return createLifecycleSql(async (): Promise<PSqlRows> => {
                    queries += 1;
                    if (queries === options.failOnQuery) {
                        throw options.queryFailure;
                    }
                    return queries === 1 ? [{ pid: 73 }] : [COMPLETED_ROW];
                }, async () => {
                    observations.closed = true;
                    if (options.closeFailure) {
                        throw options.closeFailure;
                    }
                });
            },
            writeTrace: async (path, content) => {
                observations.traces.push({ path, content });
                if (options.traceFailure) {
                    throw options.traceFailure;
                }
            }
        }
    };
}
