import {
    isRallarCrdtSnapshotEnvelope,
    isRallarCrdtUpdateEnvelope,
    type RallarCrdtJsonValue,
    type RallarCrdtOperationBatch,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';

export function createBrowserCrdtRuntimeId(prefix: string): string {
    const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
    return randomUUID
        ? randomUUID()
        : `${prefix}-${Math.random().toString(36).slice(2)}`;
}

export function sortBrowserCrdtUpdates<TPayload extends RallarCrdtOperationBatch>(
    updates: readonly RallarCrdtUpdateEnvelope<TPayload>[]
): RallarCrdtUpdateEnvelope<TPayload>[] {
    return [...updates].sort(
        (left, right) =>
            left.lamport - right.lamport ||
            left.createdAtEpochMs - right.createdAtEpochMs ||
            left.replicaId.localeCompare(right.replicaId) ||
            left.updateId.localeCompare(right.updateId)
    );
}

export function normalizeBrowserCrdtSnapshot(
    snapshot: RallarCrdtSnapshotEnvelope
): RallarCrdtSnapshotEnvelope<RallarCrdtJsonValue> {
    if (!isRallarCrdtSnapshotEnvelope(snapshot)) {
        throw new Error('CRDT transport returned an invalid snapshot envelope.');
    }
    return snapshot as RallarCrdtSnapshotEnvelope<RallarCrdtJsonValue>;
}

export function normalizeBrowserCrdtUpdate<TPayload extends RallarCrdtOperationBatch>(
    update: RallarCrdtUpdateEnvelope
): RallarCrdtUpdateEnvelope<TPayload> {
    if (!isRallarCrdtUpdateEnvelope(update)) {
        throw new Error('CRDT transport returned an invalid update envelope.');
    }
    return update as RallarCrdtUpdateEnvelope<TPayload>;
}
