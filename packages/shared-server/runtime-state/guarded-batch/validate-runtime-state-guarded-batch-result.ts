import { type JsonWireObject, type JsonWireValue } from '../../rallar-system/protocol/json-wire-identity.ts';
import type {
    RuntimeStateGuardedBatch,
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchEffectResult,
    RuntimeStateGuardedBatchGuard,
    RuntimeStateGuardedBatchGuardResult,
    RuntimeStateGuardedBatchIdentity,
    RuntimeStateGuardedBatchResult
} from './runtime-state-guarded-batch.ts';
import { validateRuntimeStateGuardedBatch } from './validate-runtime-state-guarded-batch.ts';

interface ValidateEffectResultInput {
    readonly effect: RuntimeStateGuardedBatchEffect;
    readonly input: JsonWireValue;
    readonly guardStatus: RuntimeStateGuardedBatchGuardResult['status'];
    readonly index: number;
}

export function validateRuntimeStateGuardedBatchResult(
    expectedBatch: RuntimeStateGuardedBatch,
    input: RuntimeStateGuardedBatchResult | JsonWireValue
): RuntimeStateGuardedBatchResult {
    const batch = validateRuntimeStateGuardedBatch(expectedBatch);
    const result = requireResultRecord(
        input,
        'root'
    );
    requireExactResultKeys(result, ['guard', 'effects'], 'root');
    const guardResult = validateGuardResult(batch.guard, result.guard);
    const effectResults = requireDenseResultArray(result.effects, 'effects');
    if (effectResults.length !== batch.effects.length) {
        throw invalidResult(
            `expected ${batch.effects.length} effects, received ${effectResults.length}`
        );
    }

    return {
        guard: guardResult,
        effects: batch.effects.map((effect, index) =>
            validateEffectResult({
                effect,
                input: effectResults[index],
                guardStatus: guardResult.status,
                index
            })
        )
    };
}

function validateGuardResult(
    guard: RuntimeStateGuardedBatchGuard,
    input: JsonWireValue | undefined
): RuntimeStateGuardedBatchGuardResult {
    const result = requireResultRecord(input, 'guard');
    requireMatchingResultIdentity(guard, result, 'guard');
    if (result.status === 'conflict') {
        requireExactResultKeys(
            result,
            ['status', 'operation', 'namespace', 'key', 'reason'],
            'guard'
        );
        if (result.reason !== 'condition-not-met') {
            throw invalidResult('guard conflict reason is invalid');
        }
        return {
            status: 'conflict',
            operation: guard.operation,
            namespace: guard.namespace,
            key: guard.key,
            reason: 'condition-not-met'
        };
    }
    if (result.status !== 'applied') {
        throw invalidResult('guard status is invalid');
    }

    if (guard.operation === 'delete') {
        requireExactResultKeys(
            result,
            ['status', 'operation', 'namespace', 'key', 'matchedRevision'],
            'guard'
        );
        requireExactRevision(
            result.matchedRevision,
            guard.expectedRevision,
            'guard matched revision'
        );
        return {
            status: 'applied',
            operation: guard.operation,
            namespace: guard.namespace,
            key: guard.key,
            matchedRevision: guard.expectedRevision
        };
    }

    requireExactResultKeys(
        result,
        ['status', 'operation', 'namespace', 'key', 'resultingRevision'],
        'guard'
    );
    const expectedRevision = guard.operation === 'insert'
        ? 0
        : guard.expectedRevision + 1;
    requireExactRevision(
        result.resultingRevision,
        expectedRevision,
        'guard resulting revision'
    );
    return {
        status: 'applied',
        operation: guard.operation,
        namespace: guard.namespace,
        key: guard.key,
        resultingRevision: expectedRevision
    };
}

function validateEffectResult(
    input: ValidateEffectResultInput
): RuntimeStateGuardedBatchEffectResult {
    const { effect, guardStatus, index } = input;
    const label = `effect ${index}`;
    const result = requireResultRecord(input.input, label);
    requireMatchingResultIdentity(effect, result, label);
    if (result.effectId !== effect.effectId) {
        throw invalidResult(`${label} effect ID does not match`);
    }

    if (guardStatus === 'conflict') {
        requireExactResultKeys(
            result,
            ['status', 'effectId', 'operation', 'namespace', 'key', 'reason'],
            label
        );
        if (result.status !== 'skipped' || result.reason !== 'guard-conflict') {
            throw invalidResult(`${label} must be skipped after guard conflict`);
        }
        return {
            status: 'skipped',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            reason: 'guard-conflict'
        };
    }

    if (result.status === 'conflict') {
        requireExactResultKeys(
            result,
            ['status', 'effectId', 'operation', 'namespace', 'key', 'reason'],
            label
        );
        if (effect.operation === 'put') {
            throw invalidResult(`${label} put must produce an applied result`);
        }
        if (result.reason !== 'condition-not-met') {
            throw invalidResult(`${label} conflict reason is invalid`);
        }
        return {
            status: 'conflict',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            reason: 'condition-not-met'
        };
    }
    if (result.status !== 'applied') {
        throw invalidResult(`${label} status is invalid after an applied guard`);
    }

    if (effect.operation === 'delete') {
        requireExactResultKeys(
            result,
            ['status', 'effectId', 'operation', 'namespace', 'key', 'matchedRevision'],
            label
        );
        requireExactRevision(
            result.matchedRevision,
            effect.expectedRevision,
            `${label} matched revision`
        );
        return {
            status: 'applied',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            matchedRevision: effect.expectedRevision
        };
    }

    requireExactResultKeys(
        result,
        ['status', 'effectId', 'operation', 'namespace', 'key', 'resultingRevision'],
        label
    );
    const resultingRevision = requireResultRevision(
        result.resultingRevision,
        `${label} resulting revision`
    );
    if (effect.operation === 'insert' && resultingRevision !== 0) {
        throw invalidResult(`${label} insert resulting revision must be 0`);
    }
    if (
        effect.operation === 'update' &&
        resultingRevision !== effect.expectedRevision + 1
    ) {
        throw invalidResult(`${label} update resulting revision does not match`);
    }
    return {
        status: 'applied',
        effectId: effect.effectId,
        operation: effect.operation,
        namespace: effect.namespace,
        key: effect.key,
        resultingRevision
    };
}

function requireMatchingResultIdentity(
    expected: RuntimeStateGuardedBatchIdentity & Readonly<{ operation: string; }>,
    result: JsonWireObject,
    label: string
): void {
    if (
        result.operation !== expected.operation ||
        result.namespace !== expected.namespace ||
        result.key !== expected.key
    ) {
        throw invalidResult(`${label} operation or identity does not match`);
    }
}

function requireResultRecord(
    value: JsonWireValue | RuntimeStateGuardedBatchResult | undefined,
    label: string
): JsonWireObject {
    if (!isJsonWireObject(value)) {
        throw invalidResult(`${label} must be an object`);
    }
    return value;
}

function requireDenseResultArray(
    value: JsonWireValue | undefined,
    label: string
): readonly JsonWireValue[] {
    if (!Array.isArray(value)) {
        throw invalidResult(`${label} must be an array`);
    }
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
            throw invalidResult(`${label} must be dense`);
        }
    }
    return value;
}

function requireExactResultKeys(
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
        throw invalidResult(`${label} fields are invalid`);
    }
}

function requireExactRevision(
    value: JsonWireValue | undefined,
    expected: number,
    label: string
): void {
    const revision = requireResultRevision(value, label);
    if (revision !== expected) {
        throw invalidResult(`${label} does not match`);
    }
}

function requireResultRevision(value: JsonWireValue | undefined, label: string): number {
    if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        Object.is(value, -0)
    ) {
        throw invalidResult(`${label} is invalid`);
    }
    return value;
}

function isJsonWireObject(
    value: JsonWireValue | RuntimeStateGuardedBatchResult | undefined
): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResult(reason: string): Error {
    return new Error(`Invalid runtime state guarded batch result: ${reason}`);
}
