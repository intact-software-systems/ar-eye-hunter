import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    isRuntimeStateConditionalRepositoryLike,
    isRuntimeStateOptimisticTransactionalRepositoryLike,
    isRuntimeStateTransactionalRepositoryLike,
    type RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry,
} from '../../runtime-state/optimistic-runtime-state-write.ts';
import {
    decodeGroupStateGroupStorageKey,
    groupStateGroupStorageKey,
} from '../group-state-storage-keys.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../rtc-topology-errors.ts';
import {
    decideTopologySnapshot,
    type RtcTopologySnapshotObservation,
    validateTopologySnapshot,
} from '../rtc-topology-snapshot-contract.ts';
import { rtcTopologySemanticEqual } from '../rtc-topology-semantic-equality.ts';

export {
    compareTopologyTuple,
    decideTopologySnapshot,
    type RtcTopologySnapshotObservation,
    validateTopologySnapshot,
} from '../rtc-topology-snapshot-contract.ts';
export {
    RtcTopologyRepositoryInvariantCorruptionError,
    RtcTopologySnapshotRevisionConflictError,
} from '../rtc-topology-errors.ts';

export const RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE = 'rtc-topology:snapshots';

export type RtcTopologySnapshotCommitResult =
    | Readonly<{
        status: 'accepted';
        observation: Exclude<RtcTopologySnapshotObservation, 'stale'>;
        snapshot: RallarOverlayTopologySnapshot;
    }>
    | Readonly<{
        status: 'retry';
        current?: RallarOverlayTopologySnapshot;
    }>
    | Readonly<{
        status: 'superseded';
        current: RallarOverlayTopologySnapshot;
    }>;

export type RtcTopologySnapshotConditionalResult =
    | Readonly<{ status: 'accepted'; storageRevision: number }>
    | Readonly<{ status: 'conflict' }>;

export class RtcTopologySnapshotRepository extends RuntimeStateJsonStore {
    constructor(
        readonly runtimeRepository: RuntimeStateRepositoryLike,
    ) {
        super(runtimeRepository);
    }

    async findSnapshotEntry(
        ref: GroupRef,
    ): Promise<RuntimeStateEntryValue<RallarOverlayTopologySnapshot> | undefined> {
        const key = this.snapshotKey(ref);
        const entry = await this.runtimeRepository.findEntry(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            key,
        );
        return entry ? decodeSnapshotEntry(entry, ref) : undefined;
    }

    async findSnapshot(
        ref: GroupRef,
    ): Promise<RallarOverlayTopologySnapshot | undefined> {
        return (await this.findSnapshotEntry(ref))?.value;
    }

    async listSnapshotEntries(): Promise<
        readonly RuntimeStateEntryValue<RallarOverlayTopologySnapshot>[]
    > {
        const entries = await this.runtimeRepository.findAllEntries(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
        );
        return entries.map((entry) => decodeSnapshotEntry(entry));
    }

    async listSnapshotEntriesPage(
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntryValue<RallarOverlayTopologySnapshot>[]> {
        const entries = await this.listEntriesPage(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            '',
            options,
        );
        return entries.map((entry) => decodeSnapshotEntry(entry));
    }

    async commitSnapshotGuard(
        snapshot: RallarOverlayTopologySnapshot,
        expectedRevision: number | null,
    ): Promise<RtcTopologySnapshotConditionalResult> {
        const storedSnapshot = canonicalSnapshot(snapshot);
        validateTopologySnapshot(storedSnapshot, storedSnapshot.groupRef);
        const result = expectedRevision === null
            ? await this.putValueIfAbsent(
                RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                this.snapshotKey(storedSnapshot.groupRef),
                storedSnapshot,
                NEVER_EXPIRE_AT_TIMESTAMP,
            )
            : await this.putValueIfRevision(
                RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                this.snapshotKey(storedSnapshot.groupRef),
                storedSnapshot,
                NEVER_EXPIRE_AT_TIMESTAMP,
                expectedRevision,
            );
        return result.status === 'applied'
            ? { status: 'accepted', storageRevision: result.revision }
            : { status: 'conflict' };
    }

    async observeSnapshot(
        snapshot: RallarOverlayTopologySnapshot,
        _purgeAfterEpochMs: number = this.neverExpireAtTimestamp(),
    ): Promise<RtcTopologySnapshotObservation> {
        const current = await this.findSnapshotEntry(snapshot.groupRef);
        const observation = decideTopologySnapshot(current?.value, snapshot);
        if (observation === 'inserted' || observation === 'advanced') {
            const written = await this.commitSnapshotGuard(
                snapshot,
                current?.entry.revision ?? null,
            );
            if (written.status === 'conflict') {
                throw new RuntimeStateWriteConflictError();
            }
        }
        return observation;
    }

    async commitSnapshot(input: Readonly<{
        expected?: RallarOverlayTopologySnapshot;
        candidate: RallarOverlayTopologySnapshot;
    }>): Promise<RtcTopologySnapshotCommitResult> {
        const current = await this.findSnapshotEntry(input.candidate.groupRef);
        if (!sameSnapshot(current?.value, input.expected)) {
            return { status: 'retry', current: current?.value };
        }
        const observation = decideTopologySnapshot(current?.value, input.candidate);
        if (observation === 'stale') {
            return { status: 'superseded', current: current!.value };
        }
        if (observation === 'inserted' || observation === 'advanced') {
            const written = await this.commitSnapshotGuard(
                input.candidate,
                current?.entry.revision ?? null,
            );
            if (written.status === 'conflict') {
                return {
                    status: 'retry',
                    current: await this.findSnapshot(input.candidate.groupRef),
                };
            }
        }
        return {
            status: 'accepted',
            observation,
            snapshot: input.candidate,
        };
    }

    async removeSnapshot(ref: GroupRef): Promise<void> {
        const current = await this.findSnapshotEntry(ref);
        if (!current) return;
        const deleted = await this.removeSnapshotGuard(ref, current.entry.revision);
        if (deleted.status === 'conflict') {
            throw new RuntimeStateWriteConflictError();
        }
    }

    async removeSnapshotGuard(
        ref: GroupRef,
        expectedRevision: number,
    ): Promise<Readonly<{ status: 'accepted' | 'conflict' }>> {
        const deleted = await this.deleteValueIfRevision(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            this.snapshotKey(ref),
            expectedRevision,
        );
        return deleted.status === 'applied'
            ? { status: 'accepted' }
            : { status: 'conflict' };
    }

    snapshotKey(ref: GroupRef): string {
        return groupStateGroupStorageKey(ref);
    }
}

function canonicalSnapshot(
    snapshot: RallarOverlayTopologySnapshot,
): RallarOverlayTopologySnapshot {
    const ref = snapshot.groupRef;
    return {
        ...snapshot,
        groupRef: ref.workspaceId === undefined
            ? { applicationId: ref.applicationId, groupId: ref.groupId }
            : {
                applicationId: ref.applicationId,
                workspaceId: ref.workspaceId,
                groupId: ref.groupId,
            },
    };
}

export async function migrateLegacyRtcTopologySnapshotKeys(
    repository: RtcTopologySnapshotRepository,
    options: Readonly<{
        oldWritersStopped: true;
        sleep?: (delayMs: number) => Promise<void>;
    }>,
): Promise<void> {
    if (options.oldWritersStopped !== true) {
        throw new Error('RTC topology legacy migration requires old writers to be stopped');
    }
    const runtime = requireOptimisticRuntime(repository.runtimeRepository);
    const entries = await repository.runtimeRepository.findAllEntries(
        RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    );
    for (const source of entries) {
        const value = parseSnapshot(source);
        validateTopologySnapshot(value, value.groupRef);
        const canonicalKey = repository.snapshotKey(value.groupRef);
        if (source.key === canonicalKey) {
            decodeSnapshotEntry(source, value.groupRef);
            continue;
        }
        if (source.key !== legacySnapshotKey(value.groupRef)) {
            throw topologyCorruption(
                source.key,
                'RTC topology legacy snapshot key differs from its stored scope',
            );
        }
        let lastConflict: RuntimeStateWriteConflictError | undefined;
        let migrated = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await waitForRuntimeStateWriteRetry(attempt as 0 | 1 | 2, {
                sleep: options.sleep,
            });
            try {
                await runtime.begin(async (transaction) => {
                    const current = await transaction.findEntry(
                        RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                        source.key,
                    );
                    if (!current) return;
                    const currentValue = parseSnapshot(current);
                    validateTopologySnapshot(currentValue, value.groupRef);
                    const destination = await transaction.findEntry(
                        RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                        canonicalKey,
                    );
                    if (destination) {
                        const destinationValue = decodeSnapshotEntry(
                            destination,
                            value.groupRef,
                        ).value;
                        if (!rtcTopologySemanticEqual(destinationValue, currentValue)) {
                            throw topologyCorruption(
                                canonicalKey,
                                'RTC topology migration destination differs',
                            );
                        }
                    } else {
                        const inserted = await transaction.insertIfAbsent(
                            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                            canonicalKey,
                            current.value,
                            NEVER_EXPIRE_AT_TIMESTAMP,
                        );
                        if (inserted.status === 'conflict') {
                            throw new RuntimeStateWriteConflictError();
                        }
                    }
                    const deleted = await transaction.deleteIfRevision(
                        RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                        current.key,
                        current.revision,
                    );
                    if (deleted.status === 'conflict') {
                        throw new RuntimeStateWriteConflictError();
                    }
                    migrated = true;
                });
                break;
            } catch (error) {
                if (!(error instanceof RuntimeStateWriteConflictError)) throw error;
                lastConflict = error;
            }
        }
        if (!migrated && lastConflict) {
            throw new RuntimeStateRetryExhaustedError(lastConflict);
        }
    }
}

function decodeSnapshotEntry(
    entry: RuntimeStateEntry,
    trustedRef?: GroupRef,
): RuntimeStateEntryValue<RallarOverlayTopologySnapshot> {
    let decoded: GroupRef;
    try {
        decoded = decodeGroupStateGroupStorageKey(entry.key);
    } catch (error) {
        throw topologyCorruption(
            entry.key,
            error instanceof Error ? error.message : 'RTC topology key is invalid',
        );
    }
    if (trustedRef && !sameGroupRef(decoded, trustedRef)) {
        throw topologyCorruption(entry.key, 'RTC topology key differs from requested slot');
    }
    if (entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP) {
        throw topologyCorruption(entry.key, 'RTC topology snapshot must not expire');
    }
    const value = parseSnapshot(entry);
    try {
        validateTopologySnapshot(value, decoded);
    } catch (error) {
        throw topologyCorruption(
            entry.key,
            error instanceof Error ? error.message : 'RTC topology snapshot is invalid',
        );
    }
    return { entry, value };
}

function parseSnapshot(entry: RuntimeStateEntry): RallarOverlayTopologySnapshot {
    try {
        return JSON.parse(entry.value) as RallarOverlayTopologySnapshot;
    } catch (error) {
        throw topologyCorruption(
            entry.key,
            error instanceof Error ? error.message : 'RTC topology JSON is invalid',
        );
    }
}

function legacySnapshotKey(ref: GroupRef): string {
    return [
        `app=${encodeURIComponent(ref.applicationId)}`,
        `ws=${encodeURIComponent(ref.workspaceId ?? '_')}`,
        `group=${encodeURIComponent(ref.groupId)}`,
    ].join(':');
}

function requireOptimisticRuntime(
    runtime: RuntimeStateRepositoryLike,
): RuntimeStateOptimisticTransactionalRepositoryLike {
    if (!isRuntimeStateOptimisticTransactionalRepositoryLike(runtime)) {
        throw new Error('RTC topology migration requires optimistic transactions');
    }
    return runtime;
}

function sameSnapshot(
    left: RallarOverlayTopologySnapshot | undefined,
    right: RallarOverlayTopologySnapshot | undefined,
): boolean {
    return left === right || rtcTopologySemanticEqual(left, right);
}

function sameGroupRef(left: GroupRef, right: GroupRef): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId;
}

function topologyCorruption(
    storageKey: string,
    message: string,
): RtcTopologyRepositoryInvariantCorruptionError {
    return new RtcTopologyRepositoryInvariantCorruptionError(storageKey, message);
}
