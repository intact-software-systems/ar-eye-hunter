import type { JsonWireObject, JsonWireValue } from '../../rallar-system/protocol/json-wire-identity.ts';
import {
    isValidRuntimeStateExpectedRevision,
    isValidRuntimeStateUpsertExpectedRevision
} from '../runtime-state-repository.ts';
import type { RuntimeStateGuardedBatch } from './runtime-state-guarded-batch.ts';

export interface RuntimeStateGuardedBatchValidationIssue {
    readonly path: string;
    readonly cause: Error;
}

export function validateRuntimeStateGuardedBatch(input: unknown): readonly RuntimeStateGuardedBatchValidationIssue[] {
    if (!isRecord(input)) {
        return [issue('batch', 'must be an object')];
    }
    const issues = [...exactKeys(input, ['guard', 'effects'], 'batch')];
    issues.push(...validateMutation(input.guard, 'guard', true));
    if (!Array.isArray(input.effects)) {
        return [...issues, issue('effects', 'must be an array')];
    }
    if (input.effects.length === 0) {
        issues.push(issue('effects', 'must not be empty'));
    }
    const identities = new Set<string>();
    const effectIds = new Set<string>();
    const guardIdentity = identityKey(input.guard);
    if (guardIdentity !== null) {
        identities.add(guardIdentity);
    }
    for (let index = 0; index < input.effects.length; index += 1) {
        const path = 'effects.' + index;
        if (!Object.hasOwn(input.effects, index)) {
            issues.push(issue(path, 'effects must be dense'));
            continue;
        }
        const effect = input.effects[index];
        issues.push(...validateMutation(effect, path, false));
        if (isRecord(effect) && typeof effect.effectId === 'string') {
            if (effectIds.has(effect.effectId)) {
                issues.push(issue(path + '.effectId', 'duplicate effect ID: ' + effect.effectId));
            }
            effectIds.add(effect.effectId);
        }
        const identity = identityKey(effect);
        if (identity !== null) {
            if (identities.has(identity)) {
                issues.push(issue(path, 'duplicate identity: ' + identity));
            }
            identities.add(identity);
        }
    }
    return issues;
}

/** Decoder/test-adapter boundary; production writes consume the already validated batch. */
export function assertRuntimeStateGuardedBatch(input: unknown): asserts input is RuntimeStateGuardedBatch {
    const issues = validateRuntimeStateGuardedBatch(input);
    if (issues.length > 0) {
        throw issues[0].cause;
    }
}

function validateMutation(
    input: JsonWireValue | undefined,
    path: string,
    isGuard: boolean
): readonly RuntimeStateGuardedBatchValidationIssue[] {
    if (!isRecord(input)) {
        return [issue(path, 'must be an object')];
    }
    const issues: RuntimeStateGuardedBatchValidationIssue[] = [];
    const operation = input.operation;
    if (operation !== 'insert' && operation !== 'update' && operation !== 'delete' && operation !== 'put') {
        issues.push(issue(path + '.operation', 'operation is invalid'));
    }
    else if (isGuard && operation === 'put') {
        issues.push(issue(path + '.operation', 'put cannot be used as the guard'));
    }
    const keys = ['operation', 'namespace', 'key'];
    if (!isGuard) {
        keys.push('effectId');
        requireNonEmptyString(input.effectId, path + '.effectId', issues);
    }
    requireNonEmptyString(input.namespace, path + '.namespace', issues);
    requireNonEmptyString(input.key, path + '.key', issues);
    if (operation === 'update' || operation === 'delete') {
        keys.push('expectedRevision');
        const valid = operation === 'update'
            ? isValidRuntimeStateUpsertExpectedRevision(input.expectedRevision)
            : isValidRuntimeStateExpectedRevision(input.expectedRevision);
        if (!valid) {
            issues.push(issue(path + '.expectedRevision', 'expected revision is invalid'));
        }
    }
    if (operation === 'insert' || operation === 'update' || operation === 'put') {
        keys.push('value', 'expireAtTimestamp');
        if (typeof input.value !== 'string') {
            issues.push(issue(path + '.value', 'must be a string'));
        }
        if (
            typeof input.expireAtTimestamp !== 'number' || !Number.isFinite(input.expireAtTimestamp) ||
            !Number.isFinite(new Date(input.expireAtTimestamp).getTime())
        ) {
            issues.push(issue(path + '.expireAtTimestamp', 'expiry is invalid'));
        }
    }
    issues.push(...exactKeys(input, keys, path));
    return issues;
}

function identityKey(value: JsonWireValue | undefined): string | null {
    if (!isRecord(value) || typeof value.namespace !== 'string' || typeof value.key !== 'string') {
        return null;
    }
    return JSON.stringify([value.namespace, value.key]);
}

function requireNonEmptyString(
    value: JsonWireValue | undefined,
    path: string,
    issues: RuntimeStateGuardedBatchValidationIssue[]
): void {
    if (typeof value !== 'string' || value.length === 0) {
        issues.push(issue(path, 'must be a non-empty string'));
    }
}

function exactKeys(
    value: JsonWireObject,
    expected: readonly string[],
    path: string
): readonly RuntimeStateGuardedBatchValidationIssue[] {
    const keys = Object.keys(value);
    return keys.length === expected.length && keys.every((key) => expected.includes(key))
        ? []
        : [issue(path, 'fields are invalid')];
}

function isRecord(value: unknown): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(path: string, message: string): RuntimeStateGuardedBatchValidationIssue {
    return { path, cause: new Error('Invalid runtime state guarded batch: ' + path + ' ' + message) };
}
