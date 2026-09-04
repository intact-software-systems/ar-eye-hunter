import type {
    RuntimeStateGuardedBatch,
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchEffectResult,
    RuntimeStateGuardedBatchGuardResult,
    RuntimeStateGuardedBatchResult
} from '../guarded-batch/runtime-state-guarded-batch.ts';
import {
    validateComputedRuntimeStateGuardedBatchResult,
    validateRuntimeStateGuardedBatchResult
} from '../guarded-batch/validate-runtime-state-guarded-batch-result.ts';
import { decodeRuntimeStateRevision } from './runtime-state-row-codec.ts';

export interface RuntimeStateGuardedBatchDatabaseRow {
    readonly result_kind: string;
    readonly effect_id: string | null;
    readonly operation: string;
    readonly store_namespace: string;
    readonly store_key: string;
    readonly revision: number | string;
}

interface DecodedRuntimeStateGuardedBatchRow {
    readonly resultKind: 'guard' | 'effect';
    readonly effectId: string | null;
    readonly operation: 'insert' | 'update' | 'delete' | 'put';
    readonly namespace: string;
    readonly key: string;
    readonly revision: number;
}

export function decodeRuntimeStateGuardedBatchRows(
    batch: RuntimeStateGuardedBatch,
    rows: readonly RuntimeStateGuardedBatchDatabaseRow[]
): RuntimeStateGuardedBatchResult {
    return validateRuntimeStateGuardedBatchResult(
        batch,
        decodeGuardedBatchRows(batch, rows)
    );
}

export function decodeComputedRuntimeStateGuardedBatchRows(
    batch: RuntimeStateGuardedBatch,
    rows: readonly RuntimeStateGuardedBatchDatabaseRow[]
): RuntimeStateGuardedBatchResult {
    return validateComputedRuntimeStateGuardedBatchResult(
        batch,
        decodeGuardedBatchRows(batch, rows)
    );
}

function decodeGuardedBatchRows(
    batch: RuntimeStateGuardedBatch,
    rows: readonly RuntimeStateGuardedBatchDatabaseRow[]
): RuntimeStateGuardedBatchResult {
    requireDenseRows(rows);
    let guardRow: DecodedRuntimeStateGuardedBatchRow | undefined;
    const effectRows = new Map<string, DecodedRuntimeStateGuardedBatchRow>();
    for (const inputRow of rows) {
        const row = decodeRow(inputRow);
        if (row.resultKind === 'guard') {
            if (row.effectId !== null || guardRow !== undefined) {
                throw invalidDatabaseResult('expected exactly one unique guard row');
            }
            guardRow = row;
            continue;
        }
        if (row.effectId === null || effectRows.has(row.effectId)) {
            throw invalidDatabaseResult('effect rows require unique effect IDs');
        }
        effectRows.set(row.effectId, row);
    }

    if (guardRow === undefined) {
        if (effectRows.size > 0) {
            throw invalidDatabaseResult('effects applied without guard authority');
        }
        return {
            guard: {
                status: 'conflict',
                operation: batch.guard.operation,
                namespace: batch.guard.namespace,
                key: batch.guard.key,
                reason: 'condition-not-met'
            },
            effects: batch.effects.map((effect) => ({
                status: 'skipped',
                effectId: effect.effectId,
                operation: effect.operation,
                namespace: effect.namespace,
                key: effect.key,
                reason: 'guard-conflict'
            }))
        };
    }

    const guardResult = toAppliedGuardResult(batch, guardRow);
    const effects = batch.effects.map((effect) => {
        const row = effectRows.get(effect.effectId);
        if (row === undefined) {
            if (effect.operation === 'put') {
                throw invalidDatabaseResult(
                    `put effect did not return a row: ${effect.effectId}`
                );
            }
            return {
                status: 'conflict',
                effectId: effect.effectId,
                operation: effect.operation,
                namespace: effect.namespace,
                key: effect.key,
                reason: 'condition-not-met'
            } as const;
        }
        effectRows.delete(effect.effectId);
        return toAppliedEffectResult(effect, row);
    });
    if (effectRows.size > 0) {
        throw invalidDatabaseResult('received an unexpected effect row');
    }

    return {
        guard: guardResult,
        effects
    };
}

function decodeRow(
    row: RuntimeStateGuardedBatchDatabaseRow
): DecodedRuntimeStateGuardedBatchRow {
    const resultKind = row.result_kind;
    if (resultKind !== 'guard' && resultKind !== 'effect') {
        throw invalidDatabaseResult('result kind is invalid');
    }
    const effectId = row.effect_id;
    if (effectId !== null && effectId.length === 0) {
        throw invalidDatabaseResult('effect ID is invalid');
    }
    const operation = row.operation;
    if (
        operation !== 'insert' &&
        operation !== 'update' &&
        operation !== 'delete' &&
        operation !== 'put'
    ) {
        throw invalidDatabaseResult('operation is invalid');
    }
    if (row.store_namespace.length === 0) {
        throw invalidDatabaseResult('namespace is invalid');
    }
    if (row.store_key.length === 0) {
        throw invalidDatabaseResult('key is invalid');
    }

    return {
        resultKind,
        effectId,
        operation,
        namespace: row.store_namespace,
        key: row.store_key,
        revision: decodeRuntimeStateRevision(row.revision)
    };
}

function toAppliedGuardResult(
    batch: RuntimeStateGuardedBatch,
    row: DecodedRuntimeStateGuardedBatchRow
): RuntimeStateGuardedBatchGuardResult {
    requireRowMatch(batch.guard, row, 'guard');
    return batch.guard.operation === 'delete'
        ? {
            status: 'applied',
            operation: batch.guard.operation,
            namespace: batch.guard.namespace,
            key: batch.guard.key,
            matchedRevision: row.revision
        }
        : {
            status: 'applied',
            operation: batch.guard.operation,
            namespace: batch.guard.namespace,
            key: batch.guard.key,
            resultingRevision: row.revision
        };
}

function toAppliedEffectResult(
    effect: RuntimeStateGuardedBatchEffect,
    row: DecodedRuntimeStateGuardedBatchRow
): RuntimeStateGuardedBatchEffectResult {
    requireRowMatch(effect, row, `effect ${effect.effectId}`);
    if (row.effectId !== effect.effectId) {
        throw invalidDatabaseResult(`effect ID does not match: ${effect.effectId}`);
    }
    return effect.operation === 'delete'
        ? {
            status: 'applied',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            matchedRevision: row.revision
        }
        : {
            status: 'applied',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            resultingRevision: row.revision
        };
}

function requireRowMatch(
    expected: Readonly<{
        operation: string;
        namespace: string;
        key: string;
    }>,
    row: DecodedRuntimeStateGuardedBatchRow,
    label: string
): void {
    if (
        row.operation !== expected.operation ||
        row.namespace !== expected.namespace ||
        row.key !== expected.key
    ) {
        throw invalidDatabaseResult(`${label} operation or identity does not match`);
    }
}

function requireDenseRows(
    rows: readonly RuntimeStateGuardedBatchDatabaseRow[]
): void {
    if (!Array.isArray(rows)) {
        throw invalidDatabaseResult('rows must be an array');
    }
    for (let index = 0; index < rows.length; index += 1) {
        if (!Object.hasOwn(rows, index)) {
            throw invalidDatabaseResult('rows must be dense');
        }
    }
}

function invalidDatabaseResult(reason: string): Error {
    return new Error(`Invalid runtime state guarded batch database result: ${reason}`);
}
