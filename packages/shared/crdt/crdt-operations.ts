import { createRallarCrdtLamportClock, type RallarCrdtLamportClock } from './crdt-clock.ts';
import {
    formatRallarCrdtValidation,
    validateRallarCrdtOperationBatch,
    validateRallarCrdtSnapshotEnvelope,
    validateRallarCrdtUpdateEnvelope,
    type RallarCrdtValidationOptions
} from './crdt-codec.ts';
import { toRallarCrdtDocumentKey } from './crdt-document-key.ts';
import { canonicalRallarCrdtJson, hashRallarCrdtSnapshotEnvelope, hashRallarCrdtUpdateEnvelope } from './crdt-hash.ts';
import {
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    type RallarCrdtApplyResult,
    type RallarCrdtConflict,
    type RallarCrdtConflictValue,
    type RallarCrdtCounterSnapshotAdd,
    type RallarCrdtCrdtStateSnapshot,
    type RallarCrdtDependencyBlockedUpdate,
    type RallarCrdtDependencyState,
    type RallarCrdtDocumentRef,
    type RallarCrdtJsonValue,
    type RallarCrdtMapDeleteOperation,
    type RallarCrdtMapSnapshotSet,
    type RallarCrdtNumberMergePolicy,
    type RallarCrdtNumberSnapshotWrite,
    type RallarCrdtOperation,
    type RallarCrdtOperationBatch,
    type RallarCrdtPath,
    type RallarCrdtRegisterPolicy,
    type RallarCrdtRegisterSnapshotWrite,
    type RallarCrdtSequenceSnapshotEntry,
    type RallarCrdtSequenceSnapshotPathState,
    type RallarCrdtSequenceSnapshotState,
    type RallarCrdtSetSnapshotAdd,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtUpdateEnvelope
} from './crdt-types.ts';

export type RallarCrdtDocument<TValue = unknown, TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch> =
    Readonly<{
        ref: RallarCrdtDocumentRef;
        replicaId: string;
        read(): TValue;
        conflicts(): readonly RallarCrdtConflict[];
        apply(update: RallarCrdtUpdateEnvelope<TPayload>): RallarCrdtApplyResult;
        applyLocal(payload: TPayload): RallarCrdtUpdateEnvelope<TPayload>;
        snapshot(reason?: string): RallarCrdtSnapshotEnvelope<TValue>;
        importSnapshot(snapshot: RallarCrdtSnapshotEnvelope<TValue>): void;
        seenUpdateIds(): ReadonlySet<string>;
        dependencyState(): RallarCrdtDependencyState;
        observedMapUpdateIds(path: RallarCrdtPath, key: string): readonly string[];
        observedSetAddUpdateIds(
            path: RallarCrdtPath,
            elementId: string
        ): readonly string[];
        observedSequenceUpdateIds(
            path: RallarCrdtPath,
            elementId: string
        ): readonly string[];
    }>;

export type RallarCrdtDocumentOptions<TValue = unknown> = Readonly<{
    ref: RallarCrdtDocumentRef;
    replicaId?: string;
    actorId?: string;
    sessionId?: string;
    schemaVersion?: number;
    operationVersion?: number;
    initialValue?: TValue;
    now?: () => number;
    createUpdateId?: () => string;
    createSnapshotId?: () => string;
    validation?: RallarCrdtValidationOptions;
}>;

type InternalUpdate = RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>;

type MaterializedDocument = Readonly<{
    value: unknown;
    conflicts: readonly RallarCrdtConflict[];
    tombstoneCount: number;
    crdtState: RallarCrdtCrdtStateSnapshot;
    sequenceState?: RallarCrdtSequenceSnapshotState;
}>;

type WriteMeta = Readonly<{
    updateId: string;
    replicaId: string;
    lamport: number;
    createdAtEpochMs: number;
    parents: readonly string[];
}>;

type RegisterWrite =
    & WriteMeta
    & Readonly<{
        policy: 'lww' | 'multi';
        value: RallarCrdtJsonValue;
    }>;

type SetAdd =
    & WriteMeta
    & Readonly<{
        elementId: string;
        value: RallarCrdtJsonValue;
    }>;

type MapSet =
    & WriteMeta
    & Readonly<{
        key: string;
        value: RallarCrdtJsonValue;
    }>;

type CounterAdd =
    & WriteMeta
    & Readonly<{
        delta: number;
    }>;

type NumberWrite =
    & WriteMeta
    & Readonly<{
        merge: RallarCrdtNumberMergePolicy;
        value: number;
    }>;

type SequencePosition =
    & WriteMeta
    & Readonly<{
        elementId: string;
        positionId: string;
    }>;

type SequenceInsert =
    & SequencePosition
    & Readonly<{
        value: RallarCrdtJsonValue;
    }>;

type SequenceMove = SequencePosition;

type Model = {
    registers: Map<string, RegisterWrite[]>;
    sets: Map<
        string,
        Map<string, {
            adds: Map<string, SetAdd>;
            removes: Set<string>;
        }>
    >;
    maps: Map<
        string,
        Map<string, {
            sets: Map<string, MapSet>;
            deletes: Set<string>;
        }>
    >;
    sequences: Map<
        string,
        Map<string, {
            inserts: Map<string, SequenceInsert>;
            moves: Map<string, SequenceMove>;
            deletes: Set<string>;
        }>
    >;
    counters: Map<string, CounterAdd[]>;
    numbers: Map<string, NumberWrite[]>;
    pathLookup: Map<string, RallarCrdtPath>;
    tombstoneCount: number;
};

export function createRallarCrdtDocument<
    TValue = unknown,
    TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
>(
    options: RallarCrdtDocumentOptions<TValue>
): RallarCrdtDocument<TValue, TPayload> {
    return new OperationBackedRallarCrdtDocument<TValue, TPayload>(options);
}

export function rallarCrdtBatch(
    operations: readonly RallarCrdtOperation[],
    options: Omit<RallarCrdtOperationBatch, 'kind' | 'operations'> = {}
): RallarCrdtOperationBatch {
    return {
        kind: 'batch',
        operations,
        ...(options.operationGroupId
            ? { operationGroupId: options.operationGroupId }
            : {}),
        ...(options.undo ? { undo: options.undo } : {}),
        ...(options.redo ? { redo: options.redo } : {})
    };
}

export function rallarCrdtSetRegisterOperation(
    path: RallarCrdtPath,
    value: RallarCrdtJsonValue,
    policy: RallarCrdtRegisterPolicy = 'lww'
): RallarCrdtOperation {
    return {
        kind: 'register.set',
        path,
        value,
        policy
    };
}

export const rallarCrdtResolveRegisterOperation = rallarCrdtSetRegisterOperation;

export function rallarCrdtSetMapKeyOperation(
    path: RallarCrdtPath,
    key: string,
    value: RallarCrdtJsonValue
): RallarCrdtOperation {
    return {
        kind: 'map.set',
        path,
        key,
        value
    };
}

export function rallarCrdtDeleteMapKeyOperation(
    document: Pick<RallarCrdtDocument, 'observedMapUpdateIds'>,
    path: RallarCrdtPath,
    key: string
): RallarCrdtOperation {
    return {
        kind: 'map.delete',
        path,
        key,
        observedUpdateIds: document.observedMapUpdateIds(path, key)
    };
}

export function rallarCrdtAddSetElementOperation(
    path: RallarCrdtPath,
    elementId: string,
    value: RallarCrdtJsonValue
): RallarCrdtOperation {
    return {
        kind: 'orset.add',
        path,
        elementId,
        value
    };
}

export function rallarCrdtRemoveSetElementOperation(
    document: Pick<RallarCrdtDocument, 'observedSetAddUpdateIds'>,
    path: RallarCrdtPath,
    elementId: string
): RallarCrdtOperation {
    return {
        kind: 'orset.remove',
        path,
        elementId,
        observedAddUpdateIds: document.observedSetAddUpdateIds(path, elementId)
    };
}

export function rallarCrdtSequencePositionBetween(
    before?: string,
    after?: string
): string {
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
    const min = 0;
    const max = alphabet.length - 1;
    const left = before ?? '';
    const right = after ?? '';
    let index = 0;
    let output = '';

    while (true) {
        if (index > 64) {
            return `${output}${alphabet[Math.floor(max / 2)]}`;
        }

        const leftValue = index < left.length ? alphabet.indexOf(left[index] ?? '') : min;
        const rightValue = index < right.length && right
            ? alphabet.indexOf(right[index] ?? '')
            : max;
        const safeLeft = leftValue < 0 ? min : leftValue;
        const safeRight = rightValue < 0 ? max : rightValue;

        if (safeRight - safeLeft > 1) {
            return `${output}${alphabet[Math.floor((safeLeft + safeRight) / 2)]}`;
        }

        output += alphabet[safeLeft] ?? '0';
        index += 1;
    }
}

export function rallarCrdtAddCounterOperation(
    path: RallarCrdtPath,
    delta: number
): RallarCrdtOperation {
    return {
        kind: 'counter.add',
        path,
        delta
    };
}

export function rallarCrdtIncrementCounterOperation(
    path: RallarCrdtPath,
    amount = 1
): RallarCrdtOperation {
    return rallarCrdtAddCounterOperation(path, amount);
}

export function rallarCrdtDecrementCounterOperation(
    path: RallarCrdtPath,
    amount = 1
): RallarCrdtOperation {
    return rallarCrdtAddCounterOperation(path, -amount);
}

export function rallarCrdtNumberMinOperation(
    path: RallarCrdtPath,
    value: number
): RallarCrdtOperation {
    return {
        kind: 'number.min',
        path,
        value
    };
}

export function rallarCrdtNumberMaxOperation(
    path: RallarCrdtPath,
    value: number
): RallarCrdtOperation {
    return {
        kind: 'number.max',
        path,
        value
    };
}

class OperationBackedRallarCrdtDocument<TValue, TPayload extends RallarCrdtOperationBatch>
    implements RallarCrdtDocument<TValue, TPayload> {
    public readonly ref: RallarCrdtDocumentRef;
    public readonly replicaId: string;

    private readonly documentKey: string;
    private readonly schemaVersion: number;
    private readonly operationVersion: number;
    private readonly actorId: string | undefined;
    private readonly sessionId: string | undefined;
    private readonly now: () => number;
    private readonly createUpdateId: () => string;
    private readonly createSnapshotId: () => string;
    private readonly validation: RallarCrdtValidationOptions;
    private readonly clock: RallarCrdtLamportClock;
    private readonly updates = new Map<string, InternalUpdate>();
    private readonly dependencyBlocked = new Map<string, RallarCrdtDependencyBlockedUpdate<RallarCrdtOperationBatch>>();
    private readonly snapshotSeenUpdateIds = new Set<string>();

    private baseValue: unknown;
    private baseCrdtState: RallarCrdtCrdtStateSnapshot | undefined;
    private sequenceBaseState: RallarCrdtSequenceSnapshotState | undefined;

    public constructor(options: RallarCrdtDocumentOptions<TValue>) {
        this.ref = options.ref;
        this.replicaId = options.replicaId ?? createRandomId('replica');
        this.documentKey = toRallarCrdtDocumentKey(options.ref);
        this.schemaVersion = options.schemaVersion ?? 1;
        this.operationVersion = options.operationVersion ?? RALLAR_CRDT_OPERATION_VERSION;
        this.actorId = options.actorId;
        this.sessionId = options.sessionId;
        this.now = options.now ?? Date.now;
        this.createUpdateId = options.createUpdateId ?? (() => createRandomId('update'));
        this.createSnapshotId = options.createSnapshotId ?? (() => createRandomId('snapshot'));
        this.validation = {
            allowedSchemaVersions: [this.schemaVersion],
            allowedOperationVersions: [this.operationVersion],
            ...options.validation
        };
        this.clock = createRallarCrdtLamportClock(this.replicaId);
        this.baseValue = cloneJsonValue(options.initialValue ?? {});
    }

    public read(): TValue {
        return this.materialize().value as TValue;
    }

    public conflicts(): readonly RallarCrdtConflict[] {
        return this.materialize().conflicts;
    }

    public apply(
        update: RallarCrdtUpdateEnvelope<TPayload>
    ): RallarCrdtApplyResult {
        const validation = validateRallarCrdtUpdateEnvelope(
            update,
            '$',
            this.validation
        );
        if (!validation.valid) {
            return {
                status: 'rejected',
                updateId: readUpdateId(update),
                appliedUpdateIds: [],
                releasedUpdateIds: [],
                missingDependencyIds: [],
                validation,
                error: formatRallarCrdtValidation(validation)
            };
        }

        if (toRallarCrdtDocumentKey(update.document) !== this.documentKey) {
            return {
                status: 'rejected',
                updateId: update.updateId,
                appliedUpdateIds: [],
                releasedUpdateIds: [],
                missingDependencyIds: [],
                error: 'CRDT update belongs to a different document.'
            };
        }

        if (this.hasSeenUpdate(update.updateId)) {
            return {
                status: 'duplicate',
                updateId: update.updateId,
                appliedUpdateIds: [],
                releasedUpdateIds: [],
                missingDependencyIds: []
            };
        }

        const missingDependencyIds = this.findMissingDependencies(update);
        if (missingDependencyIds.length > 0) {
            if (
                this.validation.maxBlockedUpdateCount !== undefined &&
                this.dependencyBlocked.size >=
                    this.validation.maxBlockedUpdateCount
            ) {
                return {
                    status: 'rejected',
                    updateId: update.updateId,
                    appliedUpdateIds: [],
                    releasedUpdateIds: [],
                    missingDependencyIds,
                    error: `CRDT dependency-blocked queue exceeds ${this.validation.maxBlockedUpdateCount} updates.`
                };
            }
            this.dependencyBlocked.set(update.updateId, {
                update,
                blockedAtEpochMs: this.now(),
                missingDependencyIds,
                reason: 'Missing CRDT update dependencies.'
            });
            return {
                status: 'dependency-blocked',
                updateId: update.updateId,
                appliedUpdateIds: [],
                releasedUpdateIds: [],
                missingDependencyIds
            };
        }

        this.applyReadyUpdate(update);
        const releasedUpdateIds = this.drainDependencyBlockedUpdates();

        return {
            status: 'applied',
            updateId: update.updateId,
            appliedUpdateIds: [update.updateId, ...releasedUpdateIds],
            releasedUpdateIds,
            missingDependencyIds: []
        };
    }

    public applyLocal(payload: TPayload): RallarCrdtUpdateEnvelope<TPayload> {
        const payloadValidation = validateRallarCrdtOperationBatch(
            payload,
            '$.payload',
            this.validation
        );
        if (!payloadValidation.valid) {
            throw new Error(formatRallarCrdtValidation(payloadValidation));
        }

        const lamport = this.clock.tick();
        const parents = this.compactParentIds(payload);
        const clock = this.clock.snapshot();
        const updateWithoutHash: RallarCrdtUpdateEnvelope<TPayload> = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: this.ref,
            updateId: this.createUpdateId(),
            replicaId: this.replicaId,
            actorId: this.actorId,
            sessionId: this.sessionId,
            lamport,
            parents,
            schemaVersion: this.schemaVersion,
            operationVersion: this.operationVersion,
            createdAtEpochMs: this.now(),
            causalFrontier: {
                frontierUpdateIds: parents,
                replicaClocks: clock.replicaClocks
            },
            payload
        };
        const update = {
            ...updateWithoutHash,
            hash: hashRallarCrdtUpdateEnvelope(updateWithoutHash)
        };

        const result = this.apply(update);
        if (
            result.status === 'rejected' ||
            result.status === 'dependency-blocked'
        ) {
            throw new Error(
                result.error ??
                    `Could not apply local CRDT update: ${result.status}.`
            );
        }

        return update;
    }

    public snapshot(reason?: string): RallarCrdtSnapshotEnvelope<TValue> {
        const materialized = this.materialize();
        const includedUpdateIds = this.sortedSeenUpdateIds();
        const snapshotWithoutHash: RallarCrdtSnapshotEnvelope<TValue> = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: this.ref,
            snapshotId: this.createSnapshotId(),
            schemaVersion: this.schemaVersion,
            createdAtEpochMs: this.now(),
            maxLamport: Math.max(
                this.clock.read(),
                ...Array.from(this.updates.values()).map(
                    (update) => update.lamport
                ),
                0
            ),
            includedUpdateIds,
            updateClock: this.clock.snapshot(),
            value: cloneJsonValue(materialized.value) as TValue,
            metadata: {
                createdByReplicaId: this.replicaId,
                updateCount: includedUpdateIds.length,
                tombstoneCount: materialized.tombstoneCount,
                conflictCount: materialized.conflicts.length,
                crdtState: materialized.crdtState,
                ...(materialized.sequenceState
                    ? { sequenceState: materialized.sequenceState }
                    : {}),
                ...(reason ? { reason } : {})
            }
        };

        return {
            ...snapshotWithoutHash,
            hash: hashRallarCrdtSnapshotEnvelope(snapshotWithoutHash)
        };
    }

    public importSnapshot(snapshot: RallarCrdtSnapshotEnvelope<TValue>): void {
        const validation = validateRallarCrdtSnapshotEnvelope(
            snapshot,
            '$',
            this.validation
        );
        if (!validation.valid) {
            throw new Error(formatRallarCrdtValidation(validation));
        }

        if (toRallarCrdtDocumentKey(snapshot.document) !== this.documentKey) {
            throw new Error(
                'Cannot import CRDT snapshot for a different document.'
            );
        }

        this.baseValue = cloneJsonValue(snapshot.value);
        this.baseCrdtState = snapshot.metadata.crdtState;
        this.snapshotSeenUpdateIds.clear();
        for (const updateId of snapshot.includedUpdateIds) {
            this.snapshotSeenUpdateIds.add(updateId);
            this.updates.delete(updateId);
            this.dependencyBlocked.delete(updateId);
        }
        this.sequenceBaseState = snapshot.metadata.crdtState
            ? undefined
            : snapshot.metadata.sequenceState;
        this.clock.observe(snapshot.maxLamport);
        this.drainDependencyBlockedUpdates();
    }

    public seenUpdateIds(): ReadonlySet<string> {
        return new Set(this.sortedSeenUpdateIds());
    }

    public dependencyState(): RallarCrdtDependencyState {
        const missing = new Set<string>();

        for (const blocked of this.dependencyBlocked.values()) {
            for (const updateId of blocked.missingDependencyIds) {
                if (!this.hasSeenUpdate(updateId)) {
                    missing.add(updateId);
                }
            }
        }

        return {
            seenUpdateIds: this.sortedSeenUpdateIds(),
            blockedUpdateIds: Array.from(this.dependencyBlocked.keys()).sort(),
            missingUpdateIds: Array.from(missing).sort(),
            dependencyBlockedCount: this.dependencyBlocked.size
        };
    }

    public observedMapUpdateIds(
        path: RallarCrdtPath,
        key: string
    ): readonly string[] {
        const model = this.currentModel();
        const entry = model.maps.get(toPathKey(path))?.get(key);
        if (!entry) {
            return [];
        }
        return Array.from(entry.sets.keys())
            .filter((updateId) => !entry.deletes.has(updateId))
            .sort();
    }

    public observedSetAddUpdateIds(
        path: RallarCrdtPath,
        elementId: string
    ): readonly string[] {
        const model = this.currentModel();
        const entry = model.sets.get(toPathKey(path))?.get(elementId);
        if (!entry) {
            return [];
        }
        return Array.from(entry.adds.keys())
            .filter((updateId) => !entry.removes.has(updateId))
            .sort();
    }

    public observedSequenceUpdateIds(
        path: RallarCrdtPath,
        elementId: string
    ): readonly string[] {
        const model = this.currentModel();
        const entry = model.sequences.get(toPathKey(path))?.get(elementId);
        if (!entry) {
            return [];
        }
        const lifecycleIds = new Set([
            ...entry.inserts.keys(),
            ...entry.moves.keys()
        ]);
        if (
            Array.from(entry.deletes).some((updateId) => lifecycleIds.has(updateId))
        ) {
            return [];
        }
        return Array.from(lifecycleIds).sort();
    }

    private applyReadyUpdate(
        update: RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>
    ): void {
        this.dependencyBlocked.delete(update.updateId);
        this.updates.set(update.updateId, update);
        this.clock.observe(update.lamport);
    }

    private drainDependencyBlockedUpdates(): string[] {
        const releasedUpdateIds: string[] = [];
        let progress = true;

        while (progress) {
            progress = false;
            const blockedUpdates = Array.from(
                this.dependencyBlocked.values()
            ).sort((left, right) => compareUpdates(left.update, right.update));

            for (const blocked of blockedUpdates) {
                if (this.hasSeenUpdate(blocked.update.updateId)) {
                    this.dependencyBlocked.delete(blocked.update.updateId);
                    continue;
                }

                const missing = this.findMissingDependencies(blocked.update);
                if (missing.length > 0) {
                    this.dependencyBlocked.set(blocked.update.updateId, {
                        ...blocked,
                        missingDependencyIds: missing
                    });
                    continue;
                }

                this.applyReadyUpdate(blocked.update);
                releasedUpdateIds.push(blocked.update.updateId);
                progress = true;
            }
        }

        return releasedUpdateIds;
    }

    private findMissingDependencies(
        update: RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>
    ): string[] {
        const missing = new Set<string>();
        const maybeRequire = (updateId: string): void => {
            if (!this.hasSeenUpdate(updateId)) {
                missing.add(updateId);
            }
        };

        for (const parent of update.parents) {
            maybeRequire(parent);
        }

        for (const operation of update.payload.operations) {
            if (operation.kind === 'orset.remove') {
                for (const observed of operation.observedAddUpdateIds) {
                    maybeRequire(observed);
                }
            }
            else if (
                operation.kind === 'map.delete' ||
                operation.kind === 'sequence.delete' ||
                operation.kind === 'sequence.move'
            ) {
                for (const observed of operation.observedUpdateIds) {
                    maybeRequire(observed);
                }
            }
        }

        return Array.from(missing).sort();
    }

    private hasSeenUpdate(updateId: string): boolean {
        return (
            this.updates.has(updateId) ||
            this.snapshotSeenUpdateIds.has(updateId)
        );
    }

    private sortedSeenUpdateIds(): string[] {
        return Array.from(
            new Set([...this.snapshotSeenUpdateIds, ...this.updates.keys()])
        ).sort();
    }

    private currentModel(): Model {
        const model = createModel(this.baseCrdtState, this.sequenceBaseState);
        const updates = Array.from(this.updates.values())
            .filter(
                (update) => !this.snapshotSeenUpdateIds.has(update.updateId)
            )
            .sort(compareUpdates);

        for (const update of updates) {
            for (const operation of update.payload.operations) {
                addOperationToModel(model, update, operation);
            }
        }

        return model;
    }

    private compactParentIds(payload: RallarCrdtOperationBatch): string[] {
        const parents = new Set<string>();

        for (const operation of payload.operations) {
            for (const observed of operationObservedUpdateIds(operation)) {
                if (this.hasSeenUpdate(observed)) {
                    parents.add(observed);
                }
            }
        }

        const parented = new Set<string>();
        for (const update of this.updates.values()) {
            for (const parent of update.parents) {
                if (this.updates.has(parent)) {
                    parented.add(parent);
                }
            }
        }
        for (const updateId of this.updates.keys()) {
            if (!parented.has(updateId)) {
                parents.add(updateId);
            }
        }

        return Array.from(parents).sort();
    }

    private materialize(): MaterializedDocument {
        const model = this.currentModel();
        let value = cloneJsonValue(this.baseValue);
        const conflicts: RallarCrdtConflict[] = [];
        const sequenceState: Record<string, RallarCrdtSequenceSnapshotPathState> = {};
        const ancestors = createAncestorReader(model);

        for (const [pathKey, values] of sortedMapEntries(model.maps)) {
            const path = model.pathLookup.get(pathKey) ?? [];
            value = setJsonValueAtPath(value, path, materializeMap(values));
        }

        for (const [pathKey, values] of sortedMapEntries(model.sets)) {
            const path = model.pathLookup.get(pathKey) ?? [];
            value = setJsonValueAtPath(value, path, materializeSet(values));
        }

        for (const [pathKey, values] of sortedMapEntries(model.sequences)) {
            const path = model.pathLookup.get(pathKey) ?? [];
            const materialized = materializeSequence(values);
            value = setJsonValueAtPath(value, path, materialized.value);
            sequenceState[pathKey] = {
                path,
                entries: materialized.entries
            };
        }

        for (const [pathKey, values] of sortedMapEntries(model.counters)) {
            const path = model.pathLookup.get(pathKey) ?? [];
            value = setJsonValueAtPath(value, path, materializeCounter(values));
        }

        for (const [pathKey, values] of sortedMapEntries(model.numbers)) {
            const path = model.pathLookup.get(pathKey) ?? [];
            const materialized = materializeNumber(values);
            if (materialized.hasValue) {
                value = setJsonValueAtPath(value, path, materialized.value);
            }
        }

        for (const [pathKey, values] of sortedMapEntries(model.registers)) {
            const path = model.pathLookup.get(pathKey) ?? [];
            const materialized = materializeRegister(values, path, ancestors);
            if (materialized.conflict) {
                conflicts.push(materialized.conflict);
            }
            if (materialized.hasValue) {
                value = setJsonValueAtPath(value, path, materialized.value);
            }
        }

        return {
            value,
            conflicts,
            tombstoneCount: model.tombstoneCount,
            crdtState: createCrdtStateSnapshot(model),
            sequenceState: Object.keys(sequenceState).length > 0
                ? sequenceState
                : undefined
        };
    }
}

function createModel(
    crdtState: RallarCrdtCrdtStateSnapshot | undefined = undefined,
    sequenceState: RallarCrdtSequenceSnapshotState | undefined = undefined
): Model {
    const model: Model = {
        registers: new Map(),
        sets: new Map(),
        maps: new Map(),
        sequences: new Map(),
        counters: new Map(),
        numbers: new Map(),
        pathLookup: new Map(),
        tombstoneCount: 0
    };

    if (crdtState) {
        for (const [pathKey, state] of Object.entries(crdtState.registers)) {
            model.pathLookup.set(pathKey, state.path);
            model.registers.set(
                pathKey,
                state.writes.map((write) => ({
                    updateId: write.updateId,
                    replicaId: write.replicaId,
                    lamport: write.lamport,
                    createdAtEpochMs: write.createdAtEpochMs,
                    parents: [...write.parents],
                    policy: write.policy,
                    value: cloneJsonValue(write.value) as RallarCrdtJsonValue
                }))
            );
        }

        for (const [pathKey, state] of Object.entries(crdtState.sets)) {
            model.pathLookup.set(pathKey, state.path);
            const set = getOrCreate(model.sets, pathKey, () => new Map());
            for (const element of state.elements) {
                set.set(element.elementId, {
                    adds: new Map(
                        element.adds.map((add) => [
                            add.updateId,
                            {
                                updateId: add.updateId,
                                replicaId: add.replicaId,
                                lamport: add.lamport,
                                createdAtEpochMs: add.createdAtEpochMs,
                                parents: [...add.parents],
                                elementId: add.elementId,
                                value: cloneJsonValue(
                                    add.value
                                ) as RallarCrdtJsonValue
                            }
                        ])
                    ),
                    removes: new Set(element.removes)
                });
                model.tombstoneCount += element.removes.length;
            }
        }

        for (const [pathKey, state] of Object.entries(crdtState.maps)) {
            model.pathLookup.set(pathKey, state.path);
            const map = getOrCreate(model.maps, pathKey, () => new Map());
            for (const entry of state.entries) {
                map.set(entry.key, {
                    sets: new Map(
                        entry.sets.map((set) => [
                            set.updateId,
                            {
                                updateId: set.updateId,
                                replicaId: set.replicaId,
                                lamport: set.lamport,
                                createdAtEpochMs: set.createdAtEpochMs,
                                parents: [...set.parents],
                                key: set.key,
                                value: cloneJsonValue(
                                    set.value
                                ) as RallarCrdtJsonValue
                            }
                        ])
                    ),
                    deletes: new Set(entry.deletes)
                });
                model.tombstoneCount += entry.deletes.length;
            }
        }

        addSequenceStateToModel(model, crdtState.sequences);
        for (
            const [pathKey, state] of Object.entries(
                crdtState.counters ?? {}
            )
        ) {
            model.pathLookup.set(pathKey, state.path);
            model.counters.set(
                pathKey,
                state.adds.map((add) => ({
                    updateId: add.updateId,
                    replicaId: add.replicaId,
                    lamport: add.lamport,
                    createdAtEpochMs: add.createdAtEpochMs,
                    parents: [...add.parents],
                    delta: add.delta
                }))
            );
        }
        for (
            const [pathKey, state] of Object.entries(
                crdtState.numbers ?? {}
            )
        ) {
            model.pathLookup.set(pathKey, state.path);
            model.numbers.set(
                pathKey,
                state.writes.map((write) => ({
                    updateId: write.updateId,
                    replicaId: write.replicaId,
                    lamport: write.lamport,
                    createdAtEpochMs: write.createdAtEpochMs,
                    parents: [...write.parents],
                    merge: write.merge,
                    value: write.value
                }))
            );
        }
        return model;
    }

    addSequenceStateToModel(model, sequenceState);

    return model;
}

function addSequenceStateToModel(
    model: Model,
    sequenceState: RallarCrdtSequenceSnapshotState | undefined
): void {
    for (const [pathKey, pathState] of Object.entries(sequenceState ?? {})) {
        model.pathLookup.set(pathKey, pathState.path);
        const sequence = getOrCreate(model.sequences, pathKey, () => new Map());
        for (const entry of pathState.entries) {
            const sequenceEntry = getOrCreate(
                sequence,
                entry.elementId,
                () => ({
                    inserts: new Map<string, SequenceInsert>(),
                    moves: new Map<string, SequenceMove>(),
                    deletes: new Set<string>()
                })
            );
            sequenceEntry.inserts.set(entry.insertUpdateId, {
                updateId: entry.insertUpdateId,
                replicaId: entry.replicaId,
                lamport: entry.lamport,
                createdAtEpochMs: entry.createdAtEpochMs,
                parents: [],
                elementId: entry.elementId,
                positionId: entry.positionId,
                value: entry.value
            });
            if (entry.positionUpdateId !== entry.insertUpdateId) {
                sequenceEntry.moves.set(entry.positionUpdateId, {
                    updateId: entry.positionUpdateId,
                    replicaId: entry.replicaId,
                    lamport: entry.lamport,
                    createdAtEpochMs: entry.createdAtEpochMs,
                    parents: [],
                    elementId: entry.elementId,
                    positionId: entry.positionId
                });
            }
        }
    }
}

function addOperationToModel(
    model: Model,
    update: InternalUpdate,
    operation: RallarCrdtOperation
): void {
    const meta: WriteMeta = {
        updateId: update.updateId,
        replicaId: update.replicaId,
        lamport: update.lamport,
        createdAtEpochMs: update.createdAtEpochMs,
        parents: update.parents
    };
    const pathKey = toPathKey(operation.path);
    model.pathLookup.set(pathKey, operation.path);

    switch (operation.kind) {
        case 'orset.add': {
            const set = getOrCreate(model.sets, pathKey, () => new Map());
            const element = getOrCreate(set, operation.elementId, () => ({
                adds: new Map<string, SetAdd>(),
                removes: new Set<string>()
            }));
            element.adds.set(update.updateId, {
                ...meta,
                elementId: operation.elementId,
                value: operation.value
            });
            break;
        }
        case 'orset.remove': {
            const set = getOrCreate(model.sets, pathKey, () => new Map());
            const element = getOrCreate(set, operation.elementId, () => ({
                adds: new Map<string, SetAdd>(),
                removes: new Set<string>()
            }));
            for (const observed of operation.observedAddUpdateIds) {
                element.removes.add(observed);
                model.tombstoneCount += 1;
            }
            break;
        }
        case 'register.set': {
            const register = getOrCreate(model.registers, pathKey, () => []);
            register.push({
                ...meta,
                policy: operation.policy,
                value: operation.value
            });
            break;
        }
        case 'map.set': {
            const map = getOrCreate(model.maps, pathKey, () => new Map());
            const entry = getOrCreate(map, operation.key, () => ({
                sets: new Map<string, MapSet>(),
                deletes: new Set<string>()
            }));
            entry.sets.set(update.updateId, {
                ...meta,
                key: operation.key,
                value: operation.value
            });
            break;
        }
        case 'map.delete': {
            addMapDeleteToModel(model, pathKey, operation);
            break;
        }
        case 'sequence.insert': {
            const sequence = getOrCreate(
                model.sequences,
                pathKey,
                () => new Map()
            );
            const entry = getOrCreate(sequence, operation.elementId, () => ({
                inserts: new Map<string, SequenceInsert>(),
                moves: new Map<string, SequenceMove>(),
                deletes: new Set<string>()
            }));
            entry.inserts.set(update.updateId, {
                ...meta,
                elementId: operation.elementId,
                positionId: operation.positionId,
                value: operation.value
            });
            break;
        }
        case 'sequence.delete': {
            addSequenceDeleteToModel(model, pathKey, operation);
            break;
        }
        case 'sequence.move': {
            const sequence = getOrCreate(
                model.sequences,
                pathKey,
                () => new Map()
            );
            const entry = getOrCreate(sequence, operation.elementId, () => ({
                inserts: new Map<string, SequenceInsert>(),
                moves: new Map<string, SequenceMove>(),
                deletes: new Set<string>()
            }));
            entry.moves.set(update.updateId, {
                ...meta,
                elementId: operation.elementId,
                positionId: operation.positionId
            });
            break;
        }
        case 'counter.add': {
            const counter = getOrCreate(model.counters, pathKey, () => []);
            counter.push({
                ...meta,
                delta: operation.delta
            });
            break;
        }
        case 'number.min':
        case 'number.max': {
            const number = getOrCreate(model.numbers, pathKey, () => []);
            number.push({
                ...meta,
                merge: operation.kind === 'number.min' ? 'min' : 'max',
                value: operation.value
            });
            break;
        }
    }
}

function addMapDeleteToModel(
    model: Model,
    pathKey: string,
    operation: RallarCrdtMapDeleteOperation
): void {
    const map = getOrCreate(model.maps, pathKey, () => new Map());
    const entry = getOrCreate(map, operation.key, () => ({
        sets: new Map<string, MapSet>(),
        deletes: new Set<string>()
    }));

    for (const observed of operation.observedUpdateIds) {
        entry.deletes.add(observed);
        model.tombstoneCount += 1;
    }
}

function addSequenceDeleteToModel(
    model: Model,
    pathKey: string,
    operation: {
        elementId: string;
        observedUpdateIds: readonly string[];
    }
): void {
    const sequence = getOrCreate(model.sequences, pathKey, () => new Map());
    const entry = getOrCreate(sequence, operation.elementId, () => ({
        inserts: new Map<string, SequenceInsert>(),
        moves: new Map<string, SequenceMove>(),
        deletes: new Set<string>()
    }));

    for (const observed of operation.observedUpdateIds) {
        entry.deletes.add(observed);
        model.tombstoneCount += 1;
    }
}

function materializeMap(
    map: Map<string, {
        sets: Map<string, MapSet>;
        deletes: Set<string>;
    }>
): Record<string, unknown> {
    const value: Record<string, unknown> = {};

    for (const [key, entry] of sortedMapEntries(map)) {
        const liveSets = Array.from(entry.sets.values())
            .filter((candidate) => !entry.deletes.has(candidate.updateId))
            .sort(compareWrites);
        const winner = liveSets.at(-1);
        if (winner) {
            value[key] = cloneJsonValue(winner.value);
        }
    }

    return value;
}

function materializeSet(
    set: Map<string, {
        adds: Map<string, SetAdd>;
        removes: Set<string>;
    }>
): unknown[] {
    return sortedMapEntries(set)
        .flatMap(([elementId, entry]) => {
            const liveAdds = Array.from(entry.adds.values())
                .filter((candidate) => !entry.removes.has(candidate.updateId))
                .sort(compareWrites);
            const winner = liveAdds.at(-1);
            return winner
                ? [
                    {
                        elementId,
                        winner,
                        value: cloneJsonValue(winner.value)
                    }
                ]
                : [];
        })
        .sort(
            (left, right) =>
                left.elementId.localeCompare(right.elementId) ||
                compareWrites(left.winner, right.winner)
        )
        .map((entry) => entry.value);
}

function materializeSequence(
    sequence: Map<string, {
        inserts: Map<string, SequenceInsert>;
        moves: Map<string, SequenceMove>;
        deletes: Set<string>;
    }>
): Readonly<{
    value: unknown[];
    entries: readonly RallarCrdtSequenceSnapshotEntry[];
}> {
    const entries = sortedMapEntries(sequence)
        .flatMap(([elementId, entry]) => {
            const inserts = Array.from(entry.inserts.values()).sort(
                compareWrites
            );
            const insert = inserts.at(-1);
            if (!insert) {
                return [];
            }

            const lifecycleIds = new Set([
                ...entry.inserts.keys(),
                ...entry.moves.keys()
            ]);
            if (
                Array.from(entry.deletes).some((updateId) => lifecycleIds.has(updateId))
            ) {
                return [];
            }

            const position = [...inserts, ...entry.moves.values()]
                .sort(compareWrites)
                .at(-1) ?? insert;
            const snapshotEntry: RallarCrdtSequenceSnapshotEntry = {
                elementId,
                positionId: position.positionId,
                value: cloneJsonValue(insert.value) as RallarCrdtJsonValue,
                insertUpdateId: insert.updateId,
                positionUpdateId: position.updateId,
                replicaId: position.replicaId,
                lamport: position.lamport,
                createdAtEpochMs: position.createdAtEpochMs
            };

            return [
                {
                    snapshotEntry,
                    position,
                    value: cloneJsonValue(insert.value)
                }
            ];
        })
        .sort(
            (left, right) =>
                left.snapshotEntry.positionId.localeCompare(
                    right.snapshotEntry.positionId
                ) ||
                compareWrites(left.position, right.position) ||
                left.snapshotEntry.elementId.localeCompare(
                    right.snapshotEntry.elementId
                )
        );

    return {
        value: entries.map((entry) => entry.value),
        entries: entries.map((entry) => entry.snapshotEntry)
    };
}

function materializeCounter(adds: readonly CounterAdd[]): number {
    return adds.reduce((sum, add) => sum + add.delta, 0);
}

function materializeNumber(
    writes: readonly NumberWrite[]
): Readonly<{ hasValue: boolean; value?: number; }> {
    if (writes.length === 0) {
        return { hasValue: false };
    }

    const ordered = [...writes].sort(compareWrites);
    const merge = ordered.at(-1)?.merge ?? 'max';
    const matching = ordered.filter((write) => write.merge === merge);
    const values = (matching.length > 0 ? matching : ordered).map(
        (write) => write.value
    );
    return {
        hasValue: true,
        value: merge === 'min' ? Math.min(...values) : Math.max(...values)
    };
}

function createCrdtStateSnapshot(model: Model): RallarCrdtCrdtStateSnapshot {
    const registers: Record<string, {
        path: RallarCrdtPath;
        writes: RallarCrdtRegisterSnapshotWrite[];
    }> = {};
    const sets: Record<string, {
        path: RallarCrdtPath;
        elements: Array<{
            elementId: string;
            adds: RallarCrdtSetSnapshotAdd[];
            removes: string[];
        }>;
    }> = {};
    const maps: Record<string, {
        path: RallarCrdtPath;
        entries: Array<{
            key: string;
            sets: RallarCrdtMapSnapshotSet[];
            deletes: string[];
        }>;
    }> = {};
    const sequences: Record<string, RallarCrdtSequenceSnapshotPathState> = {};
    const counters: Record<string, {
        path: RallarCrdtPath;
        adds: RallarCrdtCounterSnapshotAdd[];
    }> = {};
    const numbers: Record<string, {
        path: RallarCrdtPath;
        writes: RallarCrdtNumberSnapshotWrite[];
    }> = {};

    for (const [pathKey, writes] of sortedMapEntries(model.registers)) {
        registers[pathKey] = {
            path: model.pathLookup.get(pathKey) ?? [],
            writes: writes.sort(compareWrites).map(toRegisterSnapshotWrite)
        };
    }

    for (const [pathKey, values] of sortedMapEntries(model.sets)) {
        sets[pathKey] = {
            path: model.pathLookup.get(pathKey) ?? [],
            elements: sortedMapEntries(values).map(([elementId, entry]) => ({
                elementId,
                adds: Array.from(entry.adds.values())
                    .sort(compareWrites)
                    .map(toSetSnapshotAdd),
                removes: Array.from(entry.removes).sort()
            }))
        };
    }

    for (const [pathKey, values] of sortedMapEntries(model.maps)) {
        maps[pathKey] = {
            path: model.pathLookup.get(pathKey) ?? [],
            entries: sortedMapEntries(values).map(([key, entry]) => ({
                key,
                sets: Array.from(entry.sets.values())
                    .sort(compareWrites)
                    .map(toMapSnapshotSet),
                deletes: Array.from(entry.deletes).sort()
            }))
        };
    }

    for (const [pathKey, values] of sortedMapEntries(model.sequences)) {
        sequences[pathKey] = {
            path: model.pathLookup.get(pathKey) ?? [],
            entries: materializeSequence(values).entries
        };
    }

    for (const [pathKey, values] of sortedMapEntries(model.counters)) {
        counters[pathKey] = {
            path: model.pathLookup.get(pathKey) ?? [],
            adds: values.sort(compareWrites).map(toCounterSnapshotAdd)
        };
    }

    for (const [pathKey, values] of sortedMapEntries(model.numbers)) {
        numbers[pathKey] = {
            path: model.pathLookup.get(pathKey) ?? [],
            writes: values.sort(compareWrites).map(toNumberSnapshotWrite)
        };
    }

    return {
        format: 'rallar.crdt.state.v1',
        registers,
        sets,
        maps,
        sequences,
        counters,
        numbers
    };
}

function toRegisterSnapshotWrite(
    write: RegisterWrite
): RallarCrdtRegisterSnapshotWrite {
    return {
        updateId: write.updateId,
        replicaId: write.replicaId,
        lamport: write.lamport,
        createdAtEpochMs: write.createdAtEpochMs,
        parents: [...write.parents],
        policy: write.policy,
        value: cloneJsonValue(write.value) as RallarCrdtJsonValue
    };
}

function toSetSnapshotAdd(add: SetAdd): RallarCrdtSetSnapshotAdd {
    return {
        updateId: add.updateId,
        replicaId: add.replicaId,
        lamport: add.lamport,
        createdAtEpochMs: add.createdAtEpochMs,
        parents: [...add.parents],
        elementId: add.elementId,
        value: cloneJsonValue(add.value) as RallarCrdtJsonValue
    };
}

function toMapSnapshotSet(set: MapSet): RallarCrdtMapSnapshotSet {
    return {
        updateId: set.updateId,
        replicaId: set.replicaId,
        lamport: set.lamport,
        createdAtEpochMs: set.createdAtEpochMs,
        parents: [...set.parents],
        key: set.key,
        value: cloneJsonValue(set.value) as RallarCrdtJsonValue
    };
}

function toCounterSnapshotAdd(add: CounterAdd): RallarCrdtCounterSnapshotAdd {
    return {
        updateId: add.updateId,
        replicaId: add.replicaId,
        lamport: add.lamport,
        createdAtEpochMs: add.createdAtEpochMs,
        parents: [...add.parents],
        delta: add.delta
    };
}

function toNumberSnapshotWrite(
    write: NumberWrite
): RallarCrdtNumberSnapshotWrite {
    return {
        updateId: write.updateId,
        replicaId: write.replicaId,
        lamport: write.lamport,
        createdAtEpochMs: write.createdAtEpochMs,
        parents: [...write.parents],
        merge: write.merge,
        value: write.value
    };
}

function materializeRegister(
    writes: readonly RegisterWrite[],
    path: RallarCrdtPath,
    ancestors: (updateId: string) => ReadonlySet<string>
): Readonly<{
    hasValue: boolean;
    value?: unknown;
    conflict?: RallarCrdtConflict;
}> {
    if (writes.length === 0) {
        return { hasValue: false };
    }

    const ordered = [...writes].sort(compareWrites);
    const effectivePolicy = ordered.at(-1)?.policy ?? 'lww';
    if (effectivePolicy === 'lww') {
        const winner = ordered[ordered.length - 1];
        return {
            hasValue: true,
            value: cloneJsonValue(winner?.value)
        };
    }

    const survivors = ordered.filter(
        (candidate) =>
            !ordered.some(
                (other) =>
                    other.updateId !== candidate.updateId &&
                    ancestors(other.updateId).has(candidate.updateId)
            )
    );

    if (survivors.length <= 1) {
        return {
            hasValue: true,
            value: cloneJsonValue(
                (survivors[0] ?? ordered[ordered.length - 1])?.value
            )
        };
    }

    const values = survivors.map(toConflictValue);
    return {
        hasValue: true,
        value: values.map((entry) => cloneJsonValue(entry.value)),
        conflict: {
            kind: 'multi-value-register',
            path,
            values
        }
    };
}

function toConflictValue(write: RegisterWrite): RallarCrdtConflictValue {
    return {
        updateId: write.updateId,
        replicaId: write.replicaId,
        lamport: write.lamport,
        createdAtEpochMs: write.createdAtEpochMs,
        value: cloneJsonValue(write.value) as RallarCrdtJsonValue
    };
}

function createAncestorReader(
    model: Model
): (updateId: string) => ReadonlySet<string> {
    const cache = new Map<string, ReadonlySet<string>>();
    const parentsByUpdateId = new Map<string, readonly string[]>();

    for (const writes of model.registers.values()) {
        for (const write of writes) {
            parentsByUpdateId.set(write.updateId, write.parents);
        }
    }
    for (const set of model.sets.values()) {
        for (const entry of set.values()) {
            for (const add of entry.adds.values()) {
                parentsByUpdateId.set(add.updateId, add.parents);
            }
        }
    }
    for (const map of model.maps.values()) {
        for (const entry of map.values()) {
            for (const set of entry.sets.values()) {
                parentsByUpdateId.set(set.updateId, set.parents);
            }
        }
    }
    for (const sequence of model.sequences.values()) {
        for (const entry of sequence.values()) {
            for (const insert of entry.inserts.values()) {
                parentsByUpdateId.set(insert.updateId, insert.parents);
            }
            for (const move of entry.moves.values()) {
                parentsByUpdateId.set(move.updateId, move.parents);
            }
        }
    }
    for (const adds of model.counters.values()) {
        for (const add of adds) {
            parentsByUpdateId.set(add.updateId, add.parents);
        }
    }
    for (const writes of model.numbers.values()) {
        for (const write of writes) {
            parentsByUpdateId.set(write.updateId, write.parents);
        }
    }

    const read = (updateId: string): ReadonlySet<string> => {
        const cached = cache.get(updateId);
        if (cached) {
            return cached;
        }

        const ancestors = new Set<string>();
        for (const parent of parentsByUpdateId.get(updateId) ?? []) {
            ancestors.add(parent);
            for (const ancestor of read(parent)) {
                ancestors.add(ancestor);
            }
        }
        cache.set(updateId, ancestors);
        return ancestors;
    };

    return read;
}

function operationObservedUpdateIds(
    operation: RallarCrdtOperation
): readonly string[] {
    switch (operation.kind) {
        case 'orset.remove':
            return operation.observedAddUpdateIds;
        case 'map.delete':
        case 'sequence.delete':
        case 'sequence.move':
            return operation.observedUpdateIds;
        case 'orset.add':
        case 'register.set':
        case 'map.set':
        case 'sequence.insert':
        case 'counter.add':
        case 'number.min':
        case 'number.max':
            return [];
    }
}

function compareUpdates(left: InternalUpdate, right: InternalUpdate): number {
    return compareWrites(left, right);
}

function compareWrites(left: WriteMeta, right: WriteMeta): number {
    return (
        left.lamport - right.lamport ||
        left.createdAtEpochMs - right.createdAtEpochMs ||
        left.replicaId.localeCompare(right.replicaId) ||
        left.updateId.localeCompare(right.updateId)
    );
}

function sortedMapEntries<K extends string, V>(
    map: ReadonlyMap<K, V>
): Array<readonly [K, V]> {
    return Array.from(map.entries()).sort(([left], [right]) => left.localeCompare(right));
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
    const existing = map.get(key);
    if (existing !== undefined) {
        return existing;
    }

    const value = create();
    map.set(key, value);
    return value;
}

function toPathKey(path: RallarCrdtPath): string {
    return canonicalRallarCrdtJson(path);
}

function setJsonValueAtPath(
    current: unknown,
    path: RallarCrdtPath,
    value: unknown
): unknown {
    const next = cloneJsonValue(current);

    if (path.length === 0) {
        return cloneJsonValue(value);
    }

    const root = isPlainRecord(next) ? next : {};
    let cursor: Record<string, unknown> = root;

    for (let index = 0; index < path.length - 1; index += 1) {
        const segment = path[index] ?? '';
        const child = cursor[segment];
        if (isPlainRecord(child)) {
            cursor = child;
        }
        else {
            const created: Record<string, unknown> = {};
            cursor[segment] = created;
            cursor = created;
        }
    }

    cursor[path[path.length - 1] ?? ''] = cloneJsonValue(value);
    return root;
}

function cloneJsonValue<T>(value: T): T {
    return JSON.parse(canonicalRallarCrdtJson(value)) as T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return (
        !!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null)
    );
}

function createRandomId(prefix: string): string {
    const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
    return randomUUID
        ? randomUUID()
        : `${prefix}-${Math.random().toString(36).slice(2)}`;
}

function readUpdateId(value: unknown): string {
    return value && typeof value === 'object' && 'updateId' in value
        ? String((value as { updateId?: unknown; }).updateId ?? 'unknown')
        : 'unknown';
}
