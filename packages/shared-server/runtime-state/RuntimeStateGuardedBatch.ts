import {
    assertRuntimeStateExpectedRevision,
    assertRuntimeStateUpsertExpectedRevision,
} from './RuntimeStateRepository.ts';

export type RuntimeStateGuardedBatchIdentity = Readonly<{
    namespace: string;
    key: string;
}>;

export type RuntimeStateGuardedBatchInsert = RuntimeStateGuardedBatchIdentity &
    Readonly<{
        operation: 'insert';
        value: string;
        expireAtTimestamp: number;
    }>;

export type RuntimeStateGuardedBatchUpdate = RuntimeStateGuardedBatchIdentity &
    Readonly<{
        operation: 'update';
        expectedRevision: number;
        value: string;
        expireAtTimestamp: number;
    }>;

export type RuntimeStateGuardedBatchDelete = RuntimeStateGuardedBatchIdentity &
    Readonly<{
        operation: 'delete';
        expectedRevision: number;
    }>;

export type RuntimeStateGuardedBatchPut = RuntimeStateGuardedBatchIdentity &
    Readonly<{
        operation: 'put';
        value: string;
        expireAtTimestamp: number;
    }>;

export type RuntimeStateGuardedBatchGuard =
    | RuntimeStateGuardedBatchInsert
    | RuntimeStateGuardedBatchUpdate
    | RuntimeStateGuardedBatchDelete;

export type RuntimeStateGuardedBatchEffect = Readonly<{ effectId: string }> &
    (
        | RuntimeStateGuardedBatchInsert
        | RuntimeStateGuardedBatchUpdate
        | RuntimeStateGuardedBatchDelete
        | RuntimeStateGuardedBatchPut
    );

export type RuntimeStateGuardedBatch = Readonly<{
    guard: RuntimeStateGuardedBatchGuard;
    effects: readonly RuntimeStateGuardedBatchEffect[];
}>;

export type RuntimeStateGuardedBatchGuardResult =
    | Readonly<{
        status: 'applied';
        operation: 'insert' | 'update';
        namespace: string;
        key: string;
        resultingRevision: number;
    }>
    | Readonly<{
        status: 'applied';
        operation: 'delete';
        namespace: string;
        key: string;
        matchedRevision: number;
    }>
    | Readonly<{
        status: 'conflict';
        operation: RuntimeStateGuardedBatchGuard['operation'];
        namespace: string;
        key: string;
        reason: 'condition-not-met';
    }>;

export type RuntimeStateGuardedBatchEffectResult =
    | Readonly<{
        status: 'applied';
        effectId: string;
        operation: 'insert' | 'update' | 'put';
        namespace: string;
        key: string;
        resultingRevision: number;
    }>
    | Readonly<{
        status: 'applied';
        effectId: string;
        operation: 'delete';
        namespace: string;
        key: string;
        matchedRevision: number;
    }>
    | Readonly<{
        status: 'conflict';
        effectId: string;
        operation: Exclude<RuntimeStateGuardedBatchEffect['operation'], 'put'>;
        namespace: string;
        key: string;
        reason: 'condition-not-met';
    }>
    | Readonly<{
        status: 'skipped';
        effectId: string;
        operation: RuntimeStateGuardedBatchEffect['operation'];
        namespace: string;
        key: string;
        reason: 'guard-conflict';
    }>;

export type RuntimeStateGuardedBatchResult = Readonly<{
    guard: RuntimeStateGuardedBatchGuardResult;
    effects: readonly RuntimeStateGuardedBatchEffectResult[];
}>;

export type RuntimeStateGuardedBatchRepositoryLike = Readonly<{
    runtimeStateGuardedBatchCapability: true;
    executeGuardedBatch(
        batch: RuntimeStateGuardedBatch,
    ): Promise<RuntimeStateGuardedBatchResult>;
}>;

export function isRuntimeStateGuardedBatchRepositoryLike(
    repository: unknown,
): repository is RuntimeStateGuardedBatchRepositoryLike {
    if (typeof repository !== 'object' || repository === null) return false;
    const candidate = repository as Readonly<Record<string, unknown>>;
    return candidate.runtimeStateGuardedBatchCapability === true &&
        typeof candidate.executeGuardedBatch === 'function';
}

export function validateRuntimeStateGuardedBatch(
    input: unknown,
): RuntimeStateGuardedBatch {
    const batch = requireRecord(input, 'runtime state guarded batch');
    requireExactKeys(batch, ['guard', 'effects'], 'runtime state guarded batch');
    const guard = validateMutation(
        batch.guard,
        false,
        'guard',
    ) as RuntimeStateGuardedBatchGuard;
    const effects = requireDenseArray(
        batch.effects,
        'runtime state guarded batch effects',
    );
    if (effects.length === 0) {
        throw invalidBatch('effects must not be empty');
    }

    const identities = new Set<string>([identityKey(guard)]);
    const effectIds = new Set<string>();
    const validatedEffects = effects.map((effect, index) => {
        const validated = validateMutation(
            effect,
            true,
            `effect ${index}`,
        ) as RuntimeStateGuardedBatchEffect;
        if (effectIds.has(validated.effectId)) {
            throw invalidBatch(`duplicate effect ID: ${validated.effectId}`);
        }
        effectIds.add(validated.effectId);
        const currentIdentity = identityKey(validated);
        if (identities.has(currentIdentity)) {
            throw invalidBatch(
                `duplicate identity: ${validated.namespace}/${validated.key}`,
            );
        }
        identities.add(currentIdentity);
        return validated;
    });

    return {
        guard,
        effects: validatedEffects,
    };
}

export function validateRuntimeStateGuardedBatchResult(
    expectedBatch: RuntimeStateGuardedBatch,
    input: unknown,
): RuntimeStateGuardedBatchResult {
    const batch = validateRuntimeStateGuardedBatch(expectedBatch);
    const result = requireResultRecord(input, 'root');
    requireExactResultKeys(result, ['guard', 'effects'], 'root');
    const guardResult = validateGuardResult(batch.guard, result.guard);
    const effectResults = requireDenseResultArray(result.effects, 'effects');
    if (effectResults.length !== batch.effects.length) {
        throw invalidResult(
            `expected ${batch.effects.length} effects, received ${effectResults.length}`,
        );
    }

    const validatedEffects = batch.effects.map((effect, index) =>
        validateEffectResult(
            effect,
            effectResults[index],
            guardResult.status,
            index,
        )
    );

    return {
        guard: guardResult,
        effects: validatedEffects,
    };
}

function validateMutation(
    input: unknown,
    isEffect: boolean,
    label: string,
): RuntimeStateGuardedBatchGuard | RuntimeStateGuardedBatchEffect {
    const mutation = requireRecord(input, `runtime state guarded batch ${label}`);
    const operation = mutation.operation;
    const commonKeys = isEffect
        ? ['effectId', 'operation', 'namespace', 'key']
        : ['operation', 'namespace', 'key'];
    const effectId = isEffect
        ? requireNonEmptyString(mutation.effectId, `${label} effect ID`)
        : undefined;
    const namespace = requireNonEmptyString(
        mutation.namespace,
        `${label} namespace`,
    );
    const key = requireNonEmptyString(mutation.key, `${label} key`);
    const common = isEffect
        ? { effectId: effectId as string, namespace, key }
        : { namespace, key };

    switch (operation) {
        case 'insert': {
            requireExactKeys(
                mutation,
                [...commonKeys, 'value', 'expireAtTimestamp'],
                `runtime state guarded batch ${label}`,
            );
            return {
                ...common,
                operation,
                value: requireString(mutation.value, `${label} value`),
                expireAtTimestamp: requireExpiry(
                    mutation.expireAtTimestamp,
                    label,
                ),
            } as RuntimeStateGuardedBatchInsert &
                Partial<Readonly<{ effectId: string }>>;
        }
        case 'update': {
            requireExactKeys(
                mutation,
                [
                    ...commonKeys,
                    'expectedRevision',
                    'value',
                    'expireAtTimestamp',
                ],
                `runtime state guarded batch ${label}`,
            );
            const expectedRevision = requireNumber(
                mutation.expectedRevision,
                `${label} expected revision`,
            );
            try {
                assertRuntimeStateUpsertExpectedRevision(expectedRevision);
            } catch {
                throw invalidBatch(
                    `${label} expected revision is invalid: ${expectedRevision}`,
                );
            }
            return {
                ...common,
                operation,
                expectedRevision,
                value: requireString(mutation.value, `${label} value`),
                expireAtTimestamp: requireExpiry(
                    mutation.expireAtTimestamp,
                    label,
                ),
            } as RuntimeStateGuardedBatchUpdate &
                Partial<Readonly<{ effectId: string }>>;
        }
        case 'delete': {
            requireExactKeys(
                mutation,
                [...commonKeys, 'expectedRevision'],
                `runtime state guarded batch ${label}`,
            );
            const expectedRevision = requireNumber(
                mutation.expectedRevision,
                `${label} expected revision`,
            );
            try {
                assertRuntimeStateExpectedRevision(expectedRevision);
            } catch {
                throw invalidBatch(
                    `${label} expected revision is invalid: ${expectedRevision}`,
                );
            }
            return {
                ...common,
                operation,
                expectedRevision,
            } as RuntimeStateGuardedBatchDelete &
                Partial<Readonly<{ effectId: string }>>;
        }
        case 'put': {
            if (!isEffect) {
                throw invalidBatch('put cannot be used as the guard');
            }
            requireExactKeys(
                mutation,
                [...commonKeys, 'value', 'expireAtTimestamp'],
                `runtime state guarded batch ${label}`,
            );
            return {
                ...common,
                operation,
                value: requireString(mutation.value, `${label} value`),
                expireAtTimestamp: requireExpiry(
                    mutation.expireAtTimestamp,
                    label,
                ),
            } as RuntimeStateGuardedBatchEffect;
        }
        default:
            throw invalidBatch(`${label} operation is invalid: ${String(operation)}`);
    }
}

function validateGuardResult(
    guard: RuntimeStateGuardedBatchGuard,
    input: unknown,
): RuntimeStateGuardedBatchGuardResult {
    const result = requireResultRecord(input, 'guard');
    requireMatchingResultIdentity(guard, result, 'guard');
    if (result.status === 'conflict') {
        requireExactResultKeys(
            result,
            ['status', 'operation', 'namespace', 'key', 'reason'],
            'guard',
        );
        if (result.reason !== 'condition-not-met') {
            throw invalidResult('guard conflict reason is invalid');
        }
        return {
            status: 'conflict',
            operation: guard.operation,
            namespace: guard.namespace,
            key: guard.key,
            reason: 'condition-not-met',
        };
    }
    if (result.status !== 'applied') {
        throw invalidResult('guard status is invalid');
    }

    if (guard.operation === 'delete') {
        requireExactResultKeys(
            result,
            ['status', 'operation', 'namespace', 'key', 'matchedRevision'],
            'guard',
        );
        requireExactRevision(
            result.matchedRevision,
            guard.expectedRevision,
            'guard matched revision',
        );
        return {
            status: 'applied',
            operation: guard.operation,
            namespace: guard.namespace,
            key: guard.key,
            matchedRevision: guard.expectedRevision,
        };
    }

    requireExactResultKeys(
        result,
        ['status', 'operation', 'namespace', 'key', 'resultingRevision'],
        'guard',
    );
    const expectedRevision = guard.operation === 'insert'
        ? 0
        : guard.expectedRevision + 1;
    requireExactRevision(
        result.resultingRevision,
        expectedRevision,
        'guard resulting revision',
    );
    return {
        status: 'applied',
        operation: guard.operation,
        namespace: guard.namespace,
        key: guard.key,
        resultingRevision: expectedRevision,
    };
}

function validateEffectResult(
    effect: RuntimeStateGuardedBatchEffect,
    input: unknown,
    guardStatus: RuntimeStateGuardedBatchGuardResult['status'],
    index: number,
): RuntimeStateGuardedBatchEffectResult {
    const label = `effect ${index}`;
    const result = requireResultRecord(input, label);
    requireMatchingResultIdentity(effect, result, label);
    if (result.effectId !== effect.effectId) {
        throw invalidResult(`${label} effect ID does not match`);
    }

    if (guardStatus === 'conflict') {
        requireExactResultKeys(
            result,
            [
                'status',
                'effectId',
                'operation',
                'namespace',
                'key',
                'reason',
            ],
            label,
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
            reason: 'guard-conflict',
        };
    }

    if (result.status === 'conflict') {
        requireExactResultKeys(
            result,
            [
                'status',
                'effectId',
                'operation',
                'namespace',
                'key',
                'reason',
            ],
            label,
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
            reason: 'condition-not-met',
        };
    }
    if (result.status !== 'applied') {
        throw invalidResult(`${label} status is invalid after an applied guard`);
    }

    if (effect.operation === 'delete') {
        requireExactResultKeys(
            result,
            [
                'status',
                'effectId',
                'operation',
                'namespace',
                'key',
                'matchedRevision',
            ],
            label,
        );
        requireExactRevision(
            result.matchedRevision,
            effect.expectedRevision,
            `${label} matched revision`,
        );
        return {
            status: 'applied',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            matchedRevision: effect.expectedRevision,
        };
    }

    requireExactResultKeys(
        result,
        [
            'status',
            'effectId',
            'operation',
            'namespace',
            'key',
            'resultingRevision',
        ],
        label,
    );
    const resultingRevision = requireResultRevision(
        result.resultingRevision,
        `${label} resulting revision`,
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
        resultingRevision,
    };
}

function requireMatchingResultIdentity(
    expected: RuntimeStateGuardedBatchIdentity & Readonly<{ operation: string }>,
    result: Readonly<Record<string, unknown>>,
    label: string,
): void {
    if (
        result.operation !== expected.operation ||
        result.namespace !== expected.namespace ||
        result.key !== expected.key
    ) {
        throw invalidResult(`${label} operation or identity does not match`);
    }
}

function requireExpiry(value: unknown, label: string): number {
    const timestamp = requireNumber(value, `${label} expiry`);
    if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) {
        throw invalidBatch(`${label} expiry is invalid`);
    }
    return timestamp;
}

function requireNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw invalidBatch(`${label} must be a non-empty string`);
    }
    return value;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== 'string') {
        throw invalidBatch(`${label} must be a string`);
    }
    return value;
}

function requireNumber(value: unknown, label: string): number {
    if (typeof value !== 'number') {
        throw invalidBatch(`${label} must be a number`);
    }
    return value;
}

function requireRecord(
    value: unknown,
    label: string,
): Readonly<Record<string, unknown>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw invalidBatch(`${label} must be an object`);
    }
    return value as Readonly<Record<string, unknown>>;
}

function requireResultRecord(
    value: unknown,
    label: string,
): Readonly<Record<string, unknown>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw invalidResult(`${label} must be an object`);
    }
    return value as Readonly<Record<string, unknown>>;
}

function requireDenseArray(value: unknown, label: string): readonly unknown[] {
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

function requireDenseResultArray(
    value: unknown,
    label: string,
): readonly unknown[] {
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

function requireExactKeys(
    value: Readonly<Record<string, unknown>>,
    keys: readonly string[],
    label: string,
): void {
    if (!hasExactKeys(value, keys)) {
        throw invalidBatch(`${label} fields are invalid`);
    }
}

function requireExactResultKeys(
    value: Readonly<Record<string, unknown>>,
    keys: readonly string[],
    label: string,
): void {
    if (!hasExactKeys(value, keys)) {
        throw invalidResult(`${label} fields are invalid`);
    }
}

function hasExactKeys(
    value: Readonly<Record<string, unknown>>,
    keys: readonly string[],
): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}

function requireExactRevision(
    value: unknown,
    expected: number,
    label: string,
): void {
    const revision = requireResultRevision(value, label);
    if (revision !== expected) {
        throw invalidResult(`${label} does not match`);
    }
}

function requireResultRevision(value: unknown, label: string): number {
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

function identityKey(identity: RuntimeStateGuardedBatchIdentity): string {
    return JSON.stringify([identity.namespace, identity.key]);
}

function invalidBatch(reason: string): Error {
    return new Error(`Invalid runtime state guarded batch: ${reason}`);
}

function invalidResult(reason: string): Error {
    return new Error(`Invalid runtime state guarded batch result: ${reason}`);
}
