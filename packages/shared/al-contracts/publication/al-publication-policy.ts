import type { RallarValidationIssue } from '../../api/rallar-validation.ts';
import { Either } from '../../resilience/Either.ts';

export interface ALPublicationDrainBudget {
    readonly messages: number;
    readonly bytes: number;
}

/** What a live channel declares: there is no product default for any field (D466). */
export interface ALPublicationPolicy {
    readonly cadenceMs: number;
    readonly retainNewest: number;
    readonly drain: ALPublicationDrainBudget;
}

export const AL_PUBLICATION_POLICY_LIMITS = {
    maxCadenceMs: 60_000,
    maxRetainNewest: 64,
    maxDrainMessages: 64,
    maxDrainBytes: 4 * 1024 * 1024
} as const;

/** Checks the ranges and integrality of a typed policy; returns every issue. */
export function validateALPublicationPolicy(policy: ALPublicationPolicy): readonly RallarValidationIssue[] {
    return [
        validateField(policy.cadenceMs, 'cadenceMs', AL_PUBLICATION_POLICY_LIMITS.maxCadenceMs),
        validateField(policy.retainNewest, 'retainNewest', AL_PUBLICATION_POLICY_LIMITS.maxRetainNewest),
        validateField(policy.drain.messages, 'drain.messages', AL_PUBLICATION_POLICY_LIMITS.maxDrainMessages),
        validateField(policy.drain.bytes, 'drain.bytes', AL_PUBLICATION_POLICY_LIMITS.maxDrainBytes)
    ].filter((issue) => issue !== undefined);
}

/** A missing or non-number field becomes NaN, which `validateALPublicationPolicy` reports at that field's path. */
export function decodeALPublicationPolicy(
    value: unknown
): Either<readonly RallarValidationIssue[], ALPublicationPolicy> {
    if (!isObject(value)) {
        return Either.ofLeft([{
            path: '$.publication',
            code: 'invalid-publication',
            message: 'Expected a publication policy object.'
        }]);
    }
    const drain = readObject(value, 'drain');
    const policy: ALPublicationPolicy = {
        cadenceMs: readNumber(value, 'cadenceMs'),
        retainNewest: readNumber(value, 'retainNewest'),
        drain: {
            messages: readNumber(drain, 'messages'),
            bytes: readNumber(drain, 'bytes')
        }
    };
    const issues = validateALPublicationPolicy(policy);
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(policy);
}

function validateField(
    value: number,
    field: string,
    limit: number
): RallarValidationIssue | undefined {
    if (isWithinLimit(value, limit)) {
        return undefined;
    }
    return {
        path: `$.publication.${field}`,
        code: `invalid-${field.replace('.', '-')}`,
        message: `Expected a positive safe integer of at most ${limit}.`
    };
}

function isWithinLimit(value: number, limit: number): boolean {
    return Number.isSafeInteger(value) && value >= 1 && value <= limit;
}

function readNumber(source: object, key: string): number {
    const field = Object.getOwnPropertyDescriptor(source, key)?.value;
    return typeof field === 'number' ? field : Number.NaN;
}

function readObject(source: object, key: string): object {
    const field = Object.getOwnPropertyDescriptor(source, key)?.value;
    return isObject(field) ? field : {};
}

function isObject(value: unknown): value is object {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
