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

export function validateALPublicationPolicy(policy: ALPublicationPolicy): readonly RallarValidationIssue[] {
    return [
        validateField(policy.cadenceMs, {
            path: '$.publication.cadenceMs',
            code: 'invalid-cadence-ms',
            limit: AL_PUBLICATION_POLICY_LIMITS.maxCadenceMs
        }),
        validateField(policy.retainNewest, {
            path: '$.publication.retainNewest',
            code: 'invalid-retain-newest',
            limit: AL_PUBLICATION_POLICY_LIMITS.maxRetainNewest
        }),
        validateField(policy.drain.messages, {
            path: '$.publication.drain.messages',
            code: 'invalid-drain-messages',
            limit: AL_PUBLICATION_POLICY_LIMITS.maxDrainMessages
        }),
        validateField(policy.drain.bytes, {
            path: '$.publication.drain.bytes',
            code: 'invalid-drain-bytes',
            limit: AL_PUBLICATION_POLICY_LIMITS.maxDrainBytes
        })
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
    const policy: ALPublicationPolicy = {
        cadenceMs: getNumber(value, 'cadenceMs'),
        retainNewest: getNumber(value, 'retainNewest'),
        drain: {
            messages: getNumber(value, 'drain', 'messages'),
            bytes: getNumber(value, 'drain', 'bytes')
        }
    };
    const issues = validateALPublicationPolicy(policy);
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(policy);
}

interface ALPublicationFieldRule {
    readonly path: string;
    readonly code: string;
    readonly limit: number;
}

function validateField(value: number, rule: ALPublicationFieldRule): RallarValidationIssue | undefined {
    if (isWithinLimit(value, rule.limit)) {
        return undefined;
    }
    return {
        path: rule.path,
        code: rule.code,
        message: `Expected a positive safe integer of at most ${rule.limit}.`
    };
}

function isWithinLimit(value: number, limit: number): boolean {
    return Number.isSafeInteger(value) && value >= 1 && value <= limit;
}

function getNumber(source: object, key: string, ...nestedKeys: readonly string[]): number {
    const field = Object.getOwnPropertyDescriptor(source, key)?.value;
    const [nestedKey, ...deeperKeys] = nestedKeys;
    if (nestedKey === undefined) {
        return typeof field === 'number' ? field : Number.NaN;
    }
    return isObject(field) ? getNumber(field, nestedKey, ...deeperKeys) : Number.NaN;
}

function isObject(value: unknown): value is object {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
