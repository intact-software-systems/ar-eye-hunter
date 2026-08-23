import { describe, expect, it } from 'vitest';

import {
    executeRtcTopologyReplayServiceLifecycle,
    RTC_TOPOLOGY_REPLAY_DRAIN_WORKLOAD_POLICY,
    runRtcTopologyReplayDrainOperationWorkloads
} from '../diagnostics/rtc-topology-replay-drain-operation-counts.ts';

describe('RTC topology replay drain operation-count harness', () => {
    it('keeps the acceptance workloads and page/turn limits fixed', () => {
        expect(RTC_TOPOLOGY_REPLAY_DRAIN_WORKLOAD_POLICY).toEqual({
            pageSize: 100,
            maxPagesPerTurn: 10,
            maxEntriesPerTurn: 1_000,
            entryCounts: [100, 1_000]
        });
    });

    it('records deterministic production-service operation counts', async () => {
        await expect(runRtcTopologyReplayDrainOperationWorkloads()).resolves.toEqual({
            schema: 'rallar.rtc-topology.replay-drain-operation-counts.v1',
            workloads: {
                caughtUp: {
                    discoveryReads: 1,
                    pageReads: 1,
                    handledEntries: 0,
                    cursorWrites: 0,
                    hydrationRuns: 0,
                    yieldedTurns: 0
                },
                entries100: {
                    discoveryReads: 1,
                    pageReads: 1,
                    handledEntries: 100,
                    cursorWrites: 1,
                    hydrationRuns: 0,
                    yieldedTurns: 0
                },
                entries1000: {
                    discoveryReads: 1,
                    pageReads: 10,
                    handledEntries: 1_000,
                    cursorWrites: 10,
                    hydrationRuns: 0,
                    yieldedTurns: 0
                },
                noRecipient: {
                    discoveryReads: 1,
                    pageReads: 1,
                    handledEntries: 100,
                    cursorWrites: 1,
                    hydrationRuns: 0,
                    yieldedTurns: 0
                },
                currentRepair: {
                    discoveryReads: 1,
                    pageReads: 1,
                    handledEntries: 100,
                    cursorWrites: 1,
                    hydrationRuns: 0,
                    yieldedTurns: 0
                },
                gapHydration: {
                    discoveryReads: 1,
                    pageReads: 1,
                    handledEntries: 0,
                    cursorWrites: 1,
                    hydrationRuns: 1,
                    yieldedTurns: 0
                }
            }
        });
    });

    it('stops a started replay service when workload execution throws', async () => {
        const calls: string[] = [];
        await expect(
            executeRtcTopologyReplayServiceLifecycle(
                {
                    start: async () => {
                        calls.push('start');
                    },
                    stop: async () => {
                        calls.push('stop');
                    }
                },
                async () => {
                    calls.push('workload');
                    throw new Error('workload failed');
                }
            )
        ).rejects.toThrow('workload failed');
        expect(calls).toEqual(['start', 'workload', 'stop']);
    });

    it('stops a replay service when start rejects after installing resources', async () => {
        const calls: string[] = [];
        await expect(
            executeRtcTopologyReplayServiceLifecycle(
                {
                    start: async () => {
                        calls.push('start');
                        throw new Error('start failed');
                    },
                    stop: async () => {
                        calls.push('stop');
                    }
                },
                async () => {
                    calls.push('workload');
                    return 'not reached';
                }
            )
        ).rejects.toThrow('start failed');
        expect(calls).toEqual(['start', 'stop']);
    });

    it('preserves start and cleanup failures together', async () => {
        const startFailure = new Error('start failed');
        const cleanupFailure = new Error('cleanup failed');
        const result = executeRtcTopologyReplayServiceLifecycle(
            {
                start: async () => {
                    throw startFailure;
                },
                stop: async () => {
                    throw cleanupFailure;
                }
            },
            async () => 'not reached'
        );

        await expect(result).rejects.toMatchObject({ errors: [startFailure, cleanupFailure] });
    });
});
