import {
    describe,
    expect,
    it
} from 'vitest';

import type { GroupStateRepositoryReads } from '@shared-server/rallar-system/group-state/persistence/group-state-repository-reads.ts';
import type { GroupRetentionService } from '@shared-server/rallar-system/group-state/retention/group-retention-service.ts';
import { startGroupRetentionReconciliation } from '@shared-server/rallar-system/group-state/retention/reconcile-group-retention.ts';

import { createTestGroup } from '../../../../create-test-group.ts';
import { createManualTimers } from '../../../../shared/resilience/manual-timers.ts';

function temporaryGroup(groupId: string) {
    return createTestGroup({ groupId, metadata: { rallarRetention: { mode: 'temporary', reconnectGraceMs: 1_000, emptyPresenceFingerprint: null } } });
}

describe('bounded retention reconciliation lifecycle', () => {
    it('visits active and archived temporary rooms once per tick, skips persistent rooms, and wraps', async () => {
        const timers = createManualTimers(1_000);
        const commands: GroupRetentionService.Command[] = [];
        const cursors: (string | undefined)[] = [];
        let scan = 0;
        const input = {
            timers,
            now: timers.nowMs,
            newObservationId: () => `scan-${++scan}`,
            pageSize: 2,
            intervalMs: 1_000,
            onFailure: (error: Error) => {
                throw error;
            },
            repository: {
                listGroupsPage: async (options: { afterKey?: string; limit: number; }) => {
                    expect(options.limit).toBe(2);
                    cursors.push(options.afterKey);
                    return options.afterKey === undefined
                        ? { groups: [temporaryGroup('one'), createTestGroup({ groupId: 'persistent' })], nextKey: 'middle' }
                        : {
                            groups: [createTestGroup({ ...temporaryGroup('two'), status: 'archived', archived: createTestGroup().updated, deleted: null })],
                            nextKey: null
                        };
                }
            },
            enqueue: async (command: GroupRetentionService.Command) => {
                commands.push(command);
            }
        };
        const stop = startGroupRetentionReconciliation(input);
        expect(commands).toEqual([]);
        await timers.advance(3_000);
        expect(commands.map((command) => command.groupRef.groupId)).toEqual(['one', 'two', 'one']);
        expect(cursors).toEqual([undefined, 'middle', undefined]);
        await stop();
        expect(timers.pendingCount()).toBe(0);
        const stopAgain = startGroupRetentionReconciliation(input);
        await timers.advance(1_000);
        expect(cursors.at(-1)).toBeUndefined();
        await stopAgain();
    });

    it('has no overlapping scan and waits for an in-flight read at stop without enqueueing its result', async () => {
        const timers = createManualTimers(1_000);
        const page = Promise.withResolvers<GroupStateRepositoryReads.GroupPage>();
        let reads = 0;
        let enqueued = 0;
        const stop = startGroupRetentionReconciliation({
            timers,
            now: timers.nowMs,
            newObservationId: () => 'scan',
            pageSize: 2,
            intervalMs: 1_000,
            onFailure: (error) => {
                throw error;
            },
            repository: {
                listGroupsPage: async () => {
                    reads += 1;
                    return await page.promise;
                }
            },
            enqueue: async () => {
                enqueued += 1;
            }
        });
        const tick = timers.advance(1_000);
        expect(reads).toBe(1);
        expect(timers.pendingCount()).toBe(0);
        let stopped = false;
        const stopping = stop().then(() => {
            stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        page.resolve({ groups: [temporaryGroup('held')], nextKey: null });
        await tick;
        await stopping;
        await timers.advance(10_000);
        expect({ reads, enqueued, stopped }).toEqual({ reads: 1, enqueued: 0, stopped: true });
    });

    it('reports a failed page and retries the same cursor before progressing', async () => {
        const timers = createManualTimers(1_000);
        const failures: Error[] = [];
        const cursors: (string | undefined)[] = [];
        const failure = new Error('read failed');
        const stop = startGroupRetentionReconciliation({
            timers,
            now: timers.nowMs,
            newObservationId: () => 'scan',
            pageSize: 2,
            intervalMs: 1_000,
            onFailure: (error) => failures.push(error),
            repository: {
                listGroupsPage: async (options) => {
                    cursors.push(options.afterKey);
                    if (cursors.length === 1) {
                        throw failure;
                    }
                    return { groups: [], nextKey: 'next' };
                }
            },
            enqueue: async () => {}
        });
        await timers.advance(2_000);
        expect(failures).toEqual([failure]);
        expect(cursors).toEqual([undefined, undefined]);
        await stop();
    });
});
