import {
    decodeGroupStateGroupStorageKey,
    groupStateGroupStorageKey
} from '@shared-server/rallar-system/group-state/persistence/group-state-storage-keys.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { RuntimeStateJsonStore } from '../../../runtime-state/runtime-state-json-store.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateRepositoryLike
} from '../../../runtime-state/runtime-state-repository.ts';
import {
    isRuntimeStateConditionalRepositoryLike,
    isRuntimeStateTransactionalRepositoryLike
} from '../../../runtime-state/runtime-state-repository.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from './rtc-topology-errors.ts';
import { rtcTopologySemanticEqual } from './rtc-topology-semantic-equal.ts';
import {
    decideTopologySnapshot,
    validateTopologySnapshot,
    type RtcTopologySnapshotObservation
} from './rtc-topology-snapshot-contract.ts';

export {
    RtcTopologyRepositoryInvariantCorruptionError,
    RtcTopologySnapshotRevisionConflictError
} from './rtc-topology-errors.ts';
export {
    compareTopologyTuple,
    decideTopologySnapshot,
    type RtcTopologySnapshotObservation,
    validateTopologySnapshot
} from './rtc-topology-snapshot-contract.ts';

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
    | Readonly<{ status: 'accepted'; storageRevision: number; }>
    | Readonly<{ status: 'conflict'; }>;

export class RtcTopologySnapshotRepository extends RuntimeStateJsonStore {
    readonly runtimeRepository: RuntimeStateRepositoryLike;

    constructor(
        runtimeRepository: RuntimeStateRepositoryLike
    ) {
        super(runtimeRepository);
        this.runtimeRepository = runtimeRepository;
    }

    async findSnapshotEntry(
        ref: GroupRef
    ): Promise<RuntimeStateEntryValue<RallarOverlayTopologySnapshot> | undefined> {
        const key = this.snapshotKey(ref);
        const entry = await this.runtimeRepository.findEntry(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            key
        );
        return entry ? decodeSnapshotEntry(entry, ref) : undefined;
    }

    async findSnapshot(
        ref: GroupRef
    ): Promise<RallarOverlayTopologySnapshot | undefined> {
        return (await this.findSnapshotEntry(ref))?.value;
    }

    async listSnapshotEntries(): Promise<readonly RuntimeStateEntryValue<RallarOverlayTopologySnapshot>[]> {
        const entries = await this.runtimeRepository.findAllEntries(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE
        );
        return entries.map((entry) => decodeSnapshotEntry(entry));
    }

    async listSnapshotEntriesPage(
        options: RuntimeStateEntryPageOptions
    ): Promise<readonly RuntimeStateEntryValue<RallarOverlayTopologySnapshot>[]> {
        const entries = await this.listEntriesPage(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            '',
            options
        );
        return entries.map((entry) => decodeSnapshotEntry(entry));
    }

    async commitSnapshotGuard(
        snapshot: RallarOverlayTopologySnapshot,
        expectedRevision: number | null
    ): Promise<RtcTopologySnapshotConditionalResult> {
        const storedSnapshot = canonicalSnapshot(snapshot);
        validateTopologySnapshot(storedSnapshot, storedSnapshot.groupRef);
        const result = expectedRevision === null
            ? await this.putValueIfAbsent(
                RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                this.snapshotKey(storedSnapshot.groupRef),
                storedSnapshot,
                NEVER_EXPIRE_AT_TIMESTAMP
            )
            : await this.putValueIfRevision(
                RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                this.snapshotKey(storedSnapshot.groupRef),
                storedSnapshot,
                NEVER_EXPIRE_AT_TIMESTAMP,
                expectedRevision
            );
        return result.status === 'applied'
            ? { status: 'accepted', storageRevision: result.revision }
            : { status: 'conflict' };
    }

    async observeSnapshot(
        snapshot: RallarOverlayTopologySnapshot,
        _purgeAfterEpochMs: number = this.neverExpireAtTimestamp()
    ): Promise<RtcTopologySnapshotObservation> {
        const current = await this.findSnapshotEntry(snapshot.groupRef);
        const observation = decideTopologySnapshot(current?.value, snapshot);
        if (observation === 'inserted' || observation === 'advanced') {
            const written = await this.commitSnapshotGuard(
                snapshot,
                current?.entry.revision ?? null
            );
            if (written.status === 'conflict') {
                throw new RuntimeStateWriteConflictError();
            }
        }
        return observation;
    }

    async commitSnapshot(
        input: Readonly<{
            expected?: RallarOverlayTopologySnapshot;
            candidate: RallarOverlayTopologySnapshot;
        }>
    ): Promise<RtcTopologySnapshotCommitResult> {
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
                current?.entry.revision ?? null
            );
            if (written.status === 'conflict') {
                return {
                    status: 'retry',
                    current: await this.findSnapshot(input.candidate.groupRef)
                };
            }
        }
        return {
            status: 'accepted',
            observation,
            snapshot: input.candidate
        };
    }

    async removeSnapshot(ref: GroupRef): Promise<void> {
        const current = await this.findSnapshotEntry(ref);
        if (!current) {
            return;
        }
        const deleted = await this.removeSnapshotGuard(ref, current.entry.revision);
        if (deleted.status === 'conflict') {
            throw new RuntimeStateWriteConflictError();
        }
    }

    async removeSnapshotGuard(
        ref: GroupRef,
        expectedRevision: number
    ): Promise<Readonly<{ status: 'accepted' | 'conflict'; }>> {
        const deleted = await this.deleteValueIfRevision(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            this.snapshotKey(ref),
            expectedRevision
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
    snapshot: RallarOverlayTopologySnapshot
): RallarOverlayTopologySnapshot {
    const ref = snapshot.groupRef;
    return {
        ...snapshot,
        groupRef: {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            groupId: ref.groupId
        }
    };
}

function decodeSnapshotEntry(
    entry: RuntimeStateEntry,
    trustedRef?: GroupRef
): RuntimeStateEntryValue<RallarOverlayTopologySnapshot> {
    let decoded: GroupRef;
    try {
        decoded = decodeGroupStateGroupStorageKey(entry.key);
    }
    catch (error) {
        throw topologyCorruption(
            entry.key,
            error instanceof Error ? error.message : 'RTC topology key is invalid'
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
    }
    catch (error) {
        throw topologyCorruption(
            entry.key,
            error instanceof Error ? error.message : 'RTC topology snapshot is invalid'
        );
    }
    return { entry, value };
}

function parseSnapshot(entry: RuntimeStateEntry): RallarOverlayTopologySnapshot {
    try {
        const value: unknown = JSON.parse(entry.value);
        validateTopologySnapshot(value, valueGroupRef(value));
        return value;
    }
    catch (error) {
        throw topologyCorruption(
            entry.key,
            error instanceof Error ? error.message : 'RTC topology JSON is invalid'
        );
    }
}

function valueGroupRef(value: unknown): GroupRef {
    if (!isUnknownRecord(value)) {
        throw new TypeError('RTC topology snapshot is invalid');
    }
    const groupRef = Object.hasOwn(value, 'groupRef')
        ? value.groupRef
        : undefined;
    if (!isUnknownRecord(groupRef)) {
        throw new TypeError('RTC topology groupRef is invalid');
    }
    const { applicationId, workspaceId, groupId } = groupRef;
    if (
        typeof applicationId !== 'string' || applicationId.length === 0 ||
        typeof workspaceId !== 'string' || workspaceId.length === 0 ||
        typeof groupId !== 'string' || groupId.length === 0
    ) {
        throw new TypeError('RTC topology groupRef is invalid');
    }
    return { applicationId, workspaceId, groupId };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameSnapshot(
    left: RallarOverlayTopologySnapshot | undefined,
    right: RallarOverlayTopologySnapshot | undefined
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
    message: string
): RtcTopologyRepositoryInvariantCorruptionError {
    return new RtcTopologyRepositoryInvariantCorruptionError(storageKey, message);
}
