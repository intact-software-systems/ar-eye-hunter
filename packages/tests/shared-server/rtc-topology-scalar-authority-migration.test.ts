import { describe, expect, it } from 'vitest';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import {
    drainRtcTopologyScalarRecomputeRequests,
    initRtcTopologyScalarRecomputeWorker,
    invalidateLegacyScalarRtcTopologyAuthority,
    RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE,
} from '@shared-server/rallar-system/repositories/RtcTopologyScalarAuthorityMigration.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state-storage-keys.ts';
import {
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
} from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import {
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import {
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
} from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('scalar RTC topology authority cutover', () => {
    it('conditionally invalidates the complete affected dependency family', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const affected = {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'affected',
        };

        await seed(runtime, RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            groupStateGroupStorageKey(affected), {
            groupRef: affected,
            sourceGroupStateRevision: 4,
        });
        await seed(runtime, RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE, 'old-work:4:1', {
            groupRef: affected,
            publicationId: 'old-work:4:1',
            workId: 'old-work',
            sourceGroupStateRevision: 4,
            overlayVersion: 1,
        });
        await seed(runtime, RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            'old-work', {
                groupRef: affected,
                publicationId: 'old-work:4:1',
                workId: 'old-work',
            });
        const result = await invalidateLegacyScalarRtcTopologyAuthority(runtime, {
            oldWritersStopped: true,
            migrationId: 'causal-tuple-v1',
            observedAtEpochMs: 100,
        });

        expect(result).toEqual({
            affectedGroupCount: 1,
            deletedSnapshotCount: 1,
            deletedPublicationCount: 1,
            deletedWorkClaimCount: 1,
            queuedRecomputeRequestCount: 1,
        });
        expect(await runtime.findAllEntries(RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE))
            .toEqual([]);
        expect(await runtime.findAllEntries(RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE))
            .toEqual([]);
        expect(await runtime.findAllEntries(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
        )).toEqual([]);
        expect(await runtime.findAllEntries(
            RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE,
        )).toHaveLength(1);
    });

    it('rolls back the guard request and family deletes after bounded conflicts', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const groupRef = {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'conflict',
        };
        await seed(runtime, RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            groupStateGroupStorageKey(groupRef), {
            groupRef,
            sourceGroupStateRevision: 3,
        });
        await seed(runtime, RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE, 'work:3:1', {
            groupRef,
            publicationId: 'work:3:1',
            workId: 'work',
            sourceGroupStateRevision: 3,
            overlayVersion: 1,
        });
        await seed(runtime, RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE, 'work', {
            groupRef,
            publicationId: 'work:3:1',
            workId: 'work',
        });
        runtime.beforeConditionalWrite = (operation, namespace) => {
            if (
                operation === 'deleteIfRevision' &&
                namespace === RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE
            ) {
                throw new RuntimeStateWriteConflictError();
            }
        };

        await expect(invalidateLegacyScalarRtcTopologyAuthority(runtime, {
            oldWritersStopped: true,
            migrationId: 'causal-tuple-v1',
            observedAtEpochMs: 100,
            sleep: () => Promise.resolve(),
        })).rejects.toBeInstanceOf(RuntimeStateRetryExhaustedError);

        expect(await runtime.findAllEntries(RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE))
            .toHaveLength(1);
        expect(await runtime.findAllEntries(RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE))
            .toHaveLength(1);
        expect(await runtime.findAllEntries(
            RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE,
        )).toEqual([]);
    });

    it('keeps failed recompute requests for restart and drains idempotently', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const groupRef = {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'restart',
        };
        await seed(runtime, RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            groupStateGroupStorageKey(groupRef), {
            groupRef,
            sourceGroupStateRevision: 8,
        });
        await invalidateLegacyScalarRtcTopologyAuthority(runtime, {
            oldWritersStopped: true,
            migrationId: 'causal-tuple-v1',
            observedAtEpochMs: 100,
        });

        await expect(drainRtcTopologyScalarRecomputeRequests(
            runtime,
            () => Promise.reject(new Error('queue unavailable')),
        )).rejects.toThrow('queue unavailable');
        expect(await runtime.findAllEntries(
            RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE,
        )).toHaveLength(1);

        const enqueued: Array<Readonly<{
            groupRef: typeof groupRef;
            requestId: string;
        }>> = [];
        const drainedAfterRestart = await drainRtcTopologyScalarRecomputeRequests(
            runtime,
            (requestedGroupRef, requestId) => {
                enqueued.push({ groupRef: requestedGroupRef, requestId });
                return Promise.resolve('enqueued');
            },
        );
        const drainedAgain = await drainRtcTopologyScalarRecomputeRequests(
            runtime,
            () => Promise.reject(new Error('must not enqueue twice')),
        );

        expect(drainedAfterRestart).toBe(1);
        expect(drainedAgain).toBe(0);
        expect(enqueued).toEqual([{
            groupRef,
            requestId: 'scalar-authority-cutover:app=app:ws=workspace:group=restart',
        }]);
        expect(await runtime.findAllEntries(
            RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE,
        )).toEqual([]);
    });

    it('replays the exact deterministic enqueue after an acknowledgement conflict', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const groupRef = {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'replay',
        };
        await seed(runtime, RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            groupStateGroupStorageKey(groupRef), {
            groupRef,
            sourceGroupStateRevision: 9,
        });
        await invalidateLegacyScalarRtcTopologyAuthority(runtime, {
            oldWritersStopped: true,
            migrationId: 'causal-tuple-v1',
            observedAtEpochMs: 100,
        });
        let forceConflict = true;
        runtime.beforeConditionalWrite = async (operation, namespace, key) => {
            if (
                forceConflict && operation === 'deleteIfRevision' &&
                namespace === RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE
            ) {
                forceConflict = false;
                const current = await runtime.findEntry(namespace, key);
                if (!current) throw new Error('recompute request disappeared');
                await runtime.upsert(
                    namespace,
                    key,
                    current.value,
                    current.expireAtTimestamp,
                );
            }
        };
        const enqueued: string[] = [];
        const enqueue = (_requestedGroupRef: typeof groupRef, requestId: string) => {
            enqueued.push(requestId);
            return Promise.resolve('enqueued' as const);
        };

        expect(await drainRtcTopologyScalarRecomputeRequests(runtime, enqueue)).toBe(0);
        expect(await drainRtcTopologyScalarRecomputeRequests(runtime, enqueue)).toBe(1);
        expect(enqueued).toEqual([
            'scalar-authority-cutover:app=app:ws=workspace:group=replay',
            'scalar-authority-cutover:app=app:ws=workspace:group=replay',
        ]);
    });

    it('fails closed and retains a scalar family whose physical key has the wrong scope', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const groupRef = {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'scope',
        };
        await seed(runtime, RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE, 'wrong-scope', {
            groupRef,
            sourceGroupStateRevision: 2,
        });

        await expect(invalidateLegacyScalarRtcTopologyAuthority(runtime, {
            oldWritersStopped: true,
            migrationId: 'causal-tuple-v1',
            observedAtEpochMs: 100,
        })).rejects.toThrow(/key|scope/u);

        expect(await runtime.findAllEntries(RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE))
            .toHaveLength(1);
        expect(await runtime.findAllEntries(
            RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE,
        )).toEqual([]);
    });

    it.each([
        ['extra field', (request: Record<string, unknown>) => ({ ...request, extra: true }),
            NEVER_EXPIRE_AT_TIMESTAMP],
        ['wrong scope', (request: Record<string, unknown>) => ({
            ...request,
            groupRef: {
                applicationId: 'app',
                workspaceId: 'workspace',
                groupId: 'other',
            },
        }), NEVER_EXPIRE_AT_TIMESTAMP],
        ['expiring request', (request: Record<string, unknown>) => request, 999],
    ])('retains a corrupt durable request with %s', async (
        _label,
        mutate,
        expireAtTimestamp,
    ) => {
        const runtime = new FakeRuntimeStateRepository();
        const groupRef = {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'strict-request',
        };
        const key = groupStateGroupStorageKey(groupRef);
        const canonicalRequest = {
            kind: 'rtc-topology-scalar-recompute',
            schemaVersion: 1,
            status: 'pending',
            migrationId: 'causal-tuple-v1',
            observedAtEpochMs: 100,
            commandHash: `sha256:${'0'.repeat(64)}`,
            groupRef,
            requestId: `scalar-authority-cutover:${key}`,
        };
        await seed(
            runtime,
            RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE,
            key,
            mutate(canonicalRequest),
            expireAtTimestamp,
        );
        let enqueueCalls = 0;

        await expect(drainRtcTopologyScalarRecomputeRequests(
            runtime,
            () => {
                enqueueCalls += 1;
                return Promise.resolve('enqueued');
            },
        )).rejects.toThrow(/recompute request/u);
        expect(enqueueCalls).toBe(0);
        expect(await runtime.findAllEntries(
            RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE,
        )).toHaveLength(1);
    });

    it('autonomously retries transient failures and stops without rescheduling', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const groupRef = {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'worker',
        };
        await seed(runtime, RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            groupStateGroupStorageKey(groupRef), {
            groupRef,
            sourceGroupStateRevision: 11,
        });
        await invalidateLegacyScalarRtcTopologyAuthority(runtime, {
            oldWritersStopped: true,
            migrationId: 'causal-tuple-v1',
            observedAtEpochMs: 100,
        });
        const scheduled: Array<{
            callback: () => void | Promise<void>;
            cancelled: boolean;
        }> = [];
        let calls = 0;
        const worker = initRtcTopologyScalarRecomputeWorker({
            runtime,
            process: () => {
                calls += 1;
                return calls === 1
                    ? Promise.reject(new Error('transient'))
                    : Promise.resolve('enqueued');
            },
            intervalMs: 50,
            retryDelaysMs: [0],
            schedule: (callback) => {
                const handle = { callback, cancelled: false };
                scheduled.push(handle);
                return handle;
            },
            cancel: (handle) => {
                if (
                    typeof handle === 'object' && handle !== null &&
                    'cancelled' in handle
                ) {
                    handle.cancelled = true;
                }
            },
        });

        await expect(worker.firstRun).rejects.toThrow('transient');
        const retry = scheduled.find((entry) => !entry.cancelled);
        if (!retry) throw new Error('worker did not schedule an autonomous retry');
        await retry.callback();
        expect(calls).toBe(2);
        expect(await runtime.findAllEntries(
            RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE,
        )).toEqual([]);
        const scheduledBeforeStop = scheduled.length;
        worker.stop();
        expect(scheduled.some((entry) => entry.cancelled)).toBe(true);
        worker.wake();
        expect(scheduled).toHaveLength(scheduledBeforeStop);
    });

    it('rejects divergent immutable observation facts for a retained request', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const groupRef = {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'divergent-replay',
        };
        const key = groupStateGroupStorageKey(groupRef);
        await seed(runtime, RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE, key, {
            groupRef,
            sourceGroupStateRevision: 13,
        });
        await invalidateLegacyScalarRtcTopologyAuthority(runtime, {
            oldWritersStopped: true,
            migrationId: 'causal-tuple-v1',
            observedAtEpochMs: 100,
        });
        await seed(runtime, RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE, key, {
            groupRef,
            sourceGroupStateRevision: 13,
        });

        await expect(invalidateLegacyScalarRtcTopologyAuthority(runtime, {
            oldWritersStopped: true,
            migrationId: 'causal-tuple-v1',
            observedAtEpochMs: 101,
        })).rejects.toThrow(/migration identity/u);
        expect(await runtime.findAllEntries(RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE))
            .toHaveLength(1);
    });

    it('requires an explicit terminal policy for an absent group', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const groupRef = {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'absent',
        };
        await seed(runtime, RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            groupStateGroupStorageKey(groupRef), {
            groupRef,
            sourceGroupStateRevision: 12,
        });
        await invalidateLegacyScalarRtcTopologyAuthority(runtime, {
            oldWritersStopped: true,
            migrationId: 'causal-tuple-v1',
            observedAtEpochMs: 100,
        });

        expect(await drainRtcTopologyScalarRecomputeRequests(
            runtime,
            () => Promise.resolve('group-absent-terminal'),
        )).toBe(1);
    });

    it('invalidates a tuple family that still has a deployed three-field claim', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const groupRef = {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'legacy-claim',
        };
        const sourceGroupStateCausalRevision = {
            groupRevision: 2,
            presenceRevision: 3,
        };
        await seed(
            runtime,
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            groupStateGroupStorageKey(groupRef),
            { groupRef, sourceGroupStateCausalRevision },
        );
        await seed(runtime, RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE, 'work:2:3:1', {
            groupRef,
            publicationId: 'work:2:3:1',
            workId: 'work',
            sourceGroupStateCausalRevision,
            overlayVersion: 1,
        });
        await seed(runtime, RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE, 'work', {
            groupRef,
            publicationId: 'work:2:3:1',
            workId: 'work',
        });

        const result = await invalidateLegacyScalarRtcTopologyAuthority(runtime, {
            oldWritersStopped: true,
            migrationId: 'causal-tuple-v1',
            observedAtEpochMs: 100,
        });

        expect(result.affectedGroupCount).toBe(1);
        expect(await runtime.findAllEntries(RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE))
            .toEqual([]);
        expect(await runtime.findAllEntries(
            RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE,
        )).toHaveLength(1);
    });
});

async function seed(
    runtime: FakeRuntimeStateRepository,
    namespace: string,
    key: string,
    value: unknown,
    expireAtTimestamp: number = NEVER_EXPIRE_AT_TIMESTAMP,
): Promise<void> {
    await runtime.upsert(
        namespace,
        key,
        JSON.stringify(value),
        expireAtTimestamp,
    );
}
