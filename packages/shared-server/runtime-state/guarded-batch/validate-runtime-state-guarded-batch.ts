import { type JsonWireObject, type JsonWireValue } from '../../rallar-system/protocol/json-wire-identity.ts';
import {
    assertRuntimeStateExpectedRevision,
    assertRuntimeStateUpsertExpectedRevision
} from '../runtime-state-repository.ts';
import {
    type RuntimeStateGuardedBatch,
    type RuntimeStateGuardedBatchDelete,
    type RuntimeStateGuardedBatchEffect,
    type RuntimeStateGuardedBatchGuard,
    type RuntimeStateGuardedBatchIdentity,
    type RuntimeStateGuardedBatchInsert,
    type RuntimeStateGuardedBatchUpdate
} from './runtime-state-guarded-batch.ts';

export function validateRuntimeStateGuardedBatch(
    input: unknown
): RuntimeStateGuardedBatch {
    const batch = requireRecord(
        input,
        'runtime state guarded batch'
    );
    requireExactKeys(batch, ['guard', 'effects'], 'runtime state guarded batch');
    const guard = validateGuard(batch.guard);
    const effects = requireDenseArray(
        batch.effects,
        'runtime state guarded batch effects'
    );
    if (effects.length === 0) {
        throw invalidBatch('effects must not be empty');
    }

    const identities = new Set<string>([identityKey(guard)]);
    const effectIds = new Set<string>();
    const validatedEffects = effects.map((effect, index) => {
        const validated = validateEffect(effect, index);
        if (effectIds.has(validated.effectId)) {
            throw invalidBatch(`duplicate effect ID: ${validated.effectId}`);
        }
        effectIds.add(validated.effectId);
        const currentIdentity = identityKey(validated);
        if (identities.has(currentIdentity)) {
            throw invalidBatch(
                `duplicate identity: ${validated.namespace}/${validated.key}`
            );
        }
        identities.add(currentIdentity);
        return validated;
    });

    return { guard, effects: validatedEffects };
}

function validateGuard(input: JsonWireValue): RuntimeStateGuardedBatchGuard {
    const mutation = requireRecord(input, 'runtime state guarded batch guard');
    if (mutation.operation === 'put') {
        throw invalidBatch('put cannot be used as the guard');
    }
    return validateMutation(mutation, 'guard');
}

function validateEffect(input: JsonWireValue, index: number): RuntimeStateGuardedBatchEffect {
    const label = `effect ${index}`;
    const mutation = requireRecord(input, `runtime state guarded batch ${label}`);
    const effectId = requireNonEmptyString(mutation.effectId, `${label} effect ID`);
    if (mutation.operation === 'put') {
        requireExactKeys(
            mutation,
            ['effectId', 'operation', 'namespace', 'key', 'value', 'expireAtTimestamp'],
            `runtime state guarded batch ${label}`
        );
        return {
            effectId,
            operation: mutation.operation,
            namespace: requireNonEmptyString(mutation.namespace, `${label} namespace`),
            key: requireNonEmptyString(mutation.key, `${label} key`),
            value: requireString(mutation.value, `${label} value`),
            expireAtTimestamp: requireExpiry(mutation.expireAtTimestamp, label)
        };
    }
    return {
        ...validateMutation(mutation, label, ['effectId']),
        effectId
    };
}

function validateMutation(
    mutation: JsonWireObject,
    label: string,
    additionalKeys: readonly string[] = []
): RuntimeStateGuardedBatchGuard {
    const commonKeys = [...additionalKeys, 'operation', 'namespace', 'key'];
    const namespace = requireNonEmptyString(mutation.namespace, `${label} namespace`);
    const key = requireNonEmptyString(mutation.key, `${label} key`);

    switch (mutation.operation) {
        case 'insert':
            requireExactKeys(
                mutation,
                [...commonKeys, 'value', 'expireAtTimestamp'],
                `runtime state guarded batch ${label}`
            );
            return {
                operation: mutation.operation,
                namespace,
                key,
                value: requireString(mutation.value, `${label} value`),
                expireAtTimestamp: requireExpiry(mutation.expireAtTimestamp, label)
            } satisfies RuntimeStateGuardedBatchInsert;
        case 'update': {
            requireExactKeys(
                mutation,
                [...commonKeys, 'expectedRevision', 'value', 'expireAtTimestamp'],
                `runtime state guarded batch ${label}`
            );
            const expectedRevision = requireNumber(
                mutation.expectedRevision,
                `${label} expected revision`
            );
            validateExpectedRevision(expectedRevision, label, 'update');
            return {
                operation: mutation.operation,
                namespace,
                key,
                expectedRevision,
                value: requireString(mutation.value, `${label} value`),
                expireAtTimestamp: requireExpiry(mutation.expireAtTimestamp, label)
            } satisfies RuntimeStateGuardedBatchUpdate;
        }
        case 'delete': {
            requireExactKeys(
                mutation,
                [...commonKeys, 'expectedRevision'],
                `runtime state guarded batch ${label}`
            );
            const expectedRevision = requireNumber(
                mutation.expectedRevision,
                `${label} expected revision`
            );
            validateExpectedRevision(expectedRevision, label, 'delete');
            return {
                operation: mutation.operation,
                namespace,
                key,
                expectedRevision
            } satisfies RuntimeStateGuardedBatchDelete;
        }
        default:
            throw invalidBatch(`${label} operation is invalid: ${String(mutation.operation)}`);
    }
}

function validateExpectedRevision(
    expectedRevision: number,
    label: string,
    operation: 'update' | 'delete'
): void {
    try {
        if (operation === 'update') {
            assertRuntimeStateUpsertExpectedRevision(expectedRevision);
        }
        else {
            assertRuntimeStateExpectedRevision(expectedRevision);
        }
    }
    catch {
        throw invalidBatch(
            `${label} expected revision is invalid: ${expectedRevision}`
        );
    }
}

function requireExpiry(value: JsonWireValue | undefined, label: string): number {
    const timestamp = requireNumber(value, `${label} expiry`);
    if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) {
        throw invalidBatch(`${label} expiry is invalid`);
    }
    return timestamp;
}

function requireNonEmptyString(value: JsonWireValue | undefined, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw invalidBatch(`${label} must be a non-empty string`);
    }
    return value;
}

function requireString(value: JsonWireValue | undefined, label: string): string {
    if (typeof value !== 'string') {
        throw invalidBatch(`${label} must be a string`);
    }
    return value;
}

function requireNumber(value: JsonWireValue | undefined, label: string): number {
    if (typeof value !== 'number') {
        throw invalidBatch(`${label} must be a number`);
    }
    return value;
}

function requireRecord(
    value: unknown,
    label: string
): JsonWireObject {
    if (!isJsonWireObject(value)) {
        throw invalidBatch(`${label} must be an object`);
    }
    return value;
}

function requireDenseArray(
    value: JsonWireValue | undefined,
    label: string
): readonly JsonWireValue[] {
    if (!Array.isArray(value)) {
        throw invalidBatch(`${label} must be an array`);
    }
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
            throw invalidBatch(`${label} must be dense`);
        }
    }
    return value;
}

function requireExactKeys(
    value: JsonWireObject,
    keys: readonly string[],
    label: string
): void {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (
        actual.length !== expected.length ||
        !actual.every((key, index) => key === expected[index])
    ) {
        throw invalidBatch(`${label} fields are invalid`);
    }
}

function identityKey(identity: RuntimeStateGuardedBatchIdentity): string {
    return JSON.stringify([identity.namespace, identity.key]);
}

function isJsonWireObject(
    value: unknown
): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidBatch(reason: string): Error {
    return new Error(`Invalid runtime state guarded batch: ${reason}`);
}
