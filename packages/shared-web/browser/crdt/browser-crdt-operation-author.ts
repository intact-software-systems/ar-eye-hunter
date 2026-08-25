import type {
    RallarCrdtCounterAddInput,
    RallarCrdtNumberMergeInput,
    RallarCrdtNumericMutationOptions,
    RallarCrdtSequenceDeleteInput,
    RallarCrdtSequenceInsertInput,
    RallarCrdtSequenceMoveInput,
    RallarCrdtSequenceMutationOptions,
    RallarCrdtUndoRedoGroupInput
} from '@shared-web/browser/crdt/rallar-crdt-contracts.ts';
import {
    rallarCrdtBatch,
    type RallarCrdtOperationBatch,
    type RallarCrdtPath,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';

export namespace BrowserCrdtOperationAuthor {
    export type Options = Readonly<{
        actorId?: string;
        replicaId: string;
    }>;
}

/** Owns the translation from ergonomic document operations to CRDT batches. */
export class BrowserCrdtOperationAuthor<TPayload extends RallarCrdtOperationBatch> {
    private readonly actorId: string;
    private readonly operationGroups = new Map<string, Set<string>>();

    public constructor(options: BrowserCrdtOperationAuthor.Options) {
        this.actorId = options.actorId ?? options.replicaId;
    }

    public sequenceInsert(
        input: RallarCrdtSequenceInsertInput,
        options: RallarCrdtSequenceMutationOptions
    ): TPayload {
        return rallarCrdtBatch(
            [
                {
                    kind: 'sequence.insert',
                    path: input.path,
                    elementId: input.elementId,
                    positionId: input.positionId,
                    value: input.value
                }
            ],
            { operationGroupId: options.operationGroupId }
        ) as TPayload;
    }

    public sequenceMove(
        input: RallarCrdtSequenceMoveInput,
        options: RallarCrdtSequenceMutationOptions
    ): TPayload {
        return rallarCrdtBatch(
            [
                {
                    kind: 'sequence.move',
                    path: input.path,
                    elementId: input.elementId,
                    positionId: input.positionId,
                    observedUpdateIds: input.observedUpdateIds
                }
            ],
            { operationGroupId: options.operationGroupId }
        ) as TPayload;
    }

    public sequenceDelete(
        input: RallarCrdtSequenceDeleteInput,
        options: RallarCrdtSequenceMutationOptions
    ): TPayload {
        return rallarCrdtBatch(
            [
                {
                    kind: 'sequence.delete',
                    path: input.path,
                    elementId: input.elementId,
                    observedUpdateIds: input.observedUpdateIds
                }
            ],
            { operationGroupId: options.operationGroupId }
        ) as TPayload;
    }

    public counterAdd(
        input: RallarCrdtCounterAddInput,
        options: RallarCrdtNumericMutationOptions
    ): TPayload {
        return rallarCrdtBatch(
            [{ kind: 'counter.add', path: input.path, delta: input.delta }],
            { operationGroupId: options.operationGroupId }
        ) as TPayload;
    }

    public counterIncrement(
        path: RallarCrdtPath,
        options: RallarCrdtNumericMutationOptions
    ): TPayload {
        return this.counterAdd({ path, delta: 1 }, options);
    }

    public counterDecrement(
        path: RallarCrdtPath,
        options: RallarCrdtNumericMutationOptions
    ): TPayload {
        return this.counterAdd({ path, delta: -1 }, options);
    }

    public numberMin(
        input: RallarCrdtNumberMergeInput,
        options: RallarCrdtNumericMutationOptions
    ): TPayload {
        return rallarCrdtBatch(
            [{ kind: 'number.min', path: input.path, value: input.value }],
            { operationGroupId: options.operationGroupId }
        ) as TPayload;
    }

    public numberMax(
        input: RallarCrdtNumberMergeInput,
        options: RallarCrdtNumericMutationOptions
    ): TPayload {
        return rallarCrdtBatch(
            [{ kind: 'number.max', path: input.path, value: input.value }],
            { operationGroupId: options.operationGroupId }
        ) as TPayload;
    }

    public operationGroupUpdateIds(operationGroupId: string): readonly string[] {
        return Array.from(
            this.operationGroups.get(operationGroupId) ?? []
        ).sort();
    }

    public undoOperationGroup(input: RallarCrdtUndoRedoGroupInput): TPayload {
        const targetUpdateIds = this.requireOperationGroup(
            'undo',
            input.targetOperationGroupId
        );
        return rallarCrdtBatch(input.operations, {
            operationGroupId: input.operationGroupId ??
                `undo:${input.targetOperationGroupId}`,
            undo: {
                actorId: this.actorId,
                targetOperationGroupId: input.targetOperationGroupId,
                targetUpdateIds
            }
        }) as TPayload;
    }

    public redoOperationGroup(input: RallarCrdtUndoRedoGroupInput): TPayload {
        const targetUpdateIds = this.requireOperationGroup(
            'redo',
            input.targetOperationGroupId
        );
        return rallarCrdtBatch(input.operations, {
            operationGroupId: input.operationGroupId ??
                `redo:${input.targetOperationGroupId}`,
            redo: {
                actorId: this.actorId,
                targetOperationGroupId: input.targetOperationGroupId,
                targetUpdateIds
            }
        }) as TPayload;
    }

    public remember(update: RallarCrdtUpdateEnvelope<TPayload>): void {
        const operationGroupId = update.payload.operationGroupId;
        if (!operationGroupId) {
            return;
        }
        const updates = this.operationGroups.get(operationGroupId) ?? new Set();
        updates.add(update.updateId);
        this.operationGroups.set(operationGroupId, updates);
    }

    private requireOperationGroup(
        action: 'undo' | 'redo',
        operationGroupId: string
    ): readonly string[] {
        const targetUpdateIds = this.operationGroupUpdateIds(operationGroupId);
        if (targetUpdateIds.length === 0) {
            throw new Error(
                `Cannot ${action} unknown CRDT operation group: ${operationGroupId}.`
            );
        }
        return targetUpdateIds;
    }
}
