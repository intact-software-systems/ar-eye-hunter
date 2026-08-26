import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import {
    isRuntimeStateGuardedBatchRepositoryLike,
    type RuntimeStateGuardedBatch,
    type RuntimeStateGuardedBatchResult
} from '@shared-server/runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { validateRuntimeStateGuardedBatch } from '@shared-server/runtime-state/guarded-batch/validate-runtime-state-guarded-batch.ts';
import type { RuntimeStateGuardedBatchDatabaseRow } from '@shared-server/runtime-state/postgres/decode-runtime-state-guarded-batch-rows.ts';
import type { AppInboxTestSqlExecution } from './app-inbox-test-database-contracts.ts';

export async function tryExecuteRuntimeStateGuardedBatch(
    execution: AppInboxTestSqlExecution
): Promise<readonly RuntimeStateGuardedBatchDatabaseRow[] | undefined> {
    const { query, runtime, values } = execution;
    if (!query.includes('with guard_input as') || !query.includes('effect_input as')) {
        return undefined;
    }
    if (!isRuntimeStateGuardedBatchRepositoryLike(runtime)) {
        throw new Error('Guarded runtime-state SQL requires a transaction runtime');
    }
    const batch = decodeRuntimeStateGuardedBatchSqlValues(values);
    return toRuntimeStateGuardedBatchRows(await runtime.executeGuardedBatch(batch));
}

export async function tryExecuteRuntimeStateConditionalMutation(
    execution: AppInboxTestSqlExecution
): Promise<readonly Readonly<{ revision: number; }>[] | undefined> {
    const { query, runtime, values } = execution;
    const isUpdate = query.includes('update runtime_state_store') &&
        query.includes('returning revision');
    const isDelete = query.includes('delete from runtime_state_store') &&
        query.includes('returning revision');
    if (!isUpdate && !isDelete) {
        return undefined;
    }
    if (!runtime) {
        throw new Error('Runtime-state SQL requires a transaction runtime');
    }
    if (isUpdate) {
        const value = readString(values[0], 'Conditional runtime-state value');
        const expireAt = readDate(values[1], 'Conditional runtime-state expiry');
        const namespace = readString(values[2], 'Conditional runtime-state namespace');
        const key = readString(values[3], 'Conditional runtime-state key');
        const expectedRevision = readRevision(
            values[4],
            'Conditional runtime-state expected revision'
        );
        const result = await runtime.upsertIfRevision(
            namespace,
            key,
            value,
            expireAt.getTime(),
            expectedRevision
        );
        return result.status === 'applied' ? [{ revision: result.revision }] : [];
    }
    const namespace = readString(values[0], 'Conditional runtime-state namespace');
    const key = readString(values[1], 'Conditional runtime-state key');
    const expectedRevision = readRevision(
        values[2],
        'Conditional runtime-state expected revision'
    );
    const result = await runtime.deleteIfRevision(namespace, key, expectedRevision);
    return result.status === 'applied' ? [{ revision: expectedRevision }] : [];
}

function decodeRuntimeStateGuardedBatchSqlValues(
    values: AppInboxTestSqlExecution['values']
): RuntimeStateGuardedBatch {
    const rawEffects = values[1];
    if (!Array.isArray(rawEffects)) {
        throw new TypeError('Guarded runtime-state SQL effects are required');
    }
    return validateRuntimeStateGuardedBatch({
        guard: normalizeRuntimeStateGuardedBatchSqlDescriptor(values[0]),
        effects: rawEffects.map(normalizeRuntimeStateGuardedBatchSqlDescriptor)
    });
}

function normalizeRuntimeStateGuardedBatchSqlDescriptor(
    input: AppInboxTestSqlExecution['values'][number]
): JsonWireObject {
    const serialized = JSON.stringify(input);
    if (serialized === undefined) {
        throw new TypeError('Guarded runtime-state SQL descriptor is required');
    }
    const parsed = decodeJsonWireValue(
        JSON.parse(serialized),
        'Guarded runtime-state SQL descriptor'
    );
    if (!isJsonWireObject(parsed)) {
        throw new TypeError('Guarded runtime-state SQL descriptor must be an object');
    }
    if (!Object.hasOwn(parsed, 'expireAtTimestamp')) {
        return parsed;
    }
    if (typeof parsed.expireAtTimestamp !== 'string') {
        throw new TypeError('Guarded runtime-state SQL expiry must be a timestamp string');
    }
    const expireAtTimestamp = new Date(parsed.expireAtTimestamp).getTime();
    if (!Number.isFinite(expireAtTimestamp)) {
        throw new TypeError('Guarded runtime-state SQL expiry is invalid');
    }
    return { ...parsed, expireAtTimestamp };
}

function toRuntimeStateGuardedBatchRows(
    result: RuntimeStateGuardedBatchResult
): readonly RuntimeStateGuardedBatchDatabaseRow[] {
    if (result.guard.status === 'conflict') {
        return [];
    }
    const rows: RuntimeStateGuardedBatchDatabaseRow[] = [
        {
            result_kind: 'guard',
            effect_id: null,
            operation: result.guard.operation,
            store_namespace: result.guard.namespace,
            store_key: result.guard.key,
            revision: 'resultingRevision' in result.guard
                ? result.guard.resultingRevision
                : result.guard.matchedRevision
        }
    ];
    for (const effect of result.effects) {
        if (effect.status !== 'applied') {
            continue;
        }
        rows.push({
            result_kind: 'effect',
            effect_id: effect.effectId,
            operation: effect.operation,
            store_namespace: effect.namespace,
            store_key: effect.key,
            revision: 'resultingRevision' in effect
                ? effect.resultingRevision
                : effect.matchedRevision
        });
    }
    return rows;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
    value: AppInboxTestSqlExecution['values'][number],
    label: string
): string {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string`);
    }
    return value;
}

function readDate(
    value: AppInboxTestSqlExecution['values'][number],
    label: string
): Date {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new TypeError(`${label} must be a valid Date`);
    }
    return value;
}

function readRevision(
    value: AppInboxTestSqlExecution['values'][number],
    label: string
): number {
    if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
    return value;
}
