import { getOwnNumber } from '../../api/exact-object-decoding.ts';
import type { RallarValidationIssue } from '../../api/rallar-validation.ts';
import { Either } from '../../resilience/Either.ts';

export type ALPublicationStageLimit = 'streams' | 'staged-values' | 'staged-bytes';

/** What one session's publication stage holds at once, across its lanes (D477). */
export interface ALPublicationStageLimits {
    readonly maxStreams: number;
    readonly maxStagedValues: number;
    readonly maxStagedBytes: number;
}

/** Frozen: every session's stage shares it, and each report returns it to the facade's readers. */
export const AL_PUBLICATION_STAGE_LIMITS: ALPublicationStageLimits = Object.freeze({
    maxStreams: 64,
    maxStagedValues: 1_000,
    maxStagedBytes: 4 * 1024 * 1024
});

const LIMIT_FIELDS = ['maxStreams', 'maxStagedValues', 'maxStagedBytes'] as const;

const LIMIT_FIELD_CODES: Readonly<Record<keyof ALPublicationStageLimits, string>> = {
    maxStreams: 'invalid-max-streams',
    maxStagedValues: 'invalid-max-staged-values',
    maxStagedBytes: 'invalid-max-staged-bytes'
};

/** Every issue names its field under `path`, the place the caller read the limits from; a missing or non-number field becomes NaN, which `validateLimitFields` reports at that field's path. */
export function decodeALPublicationStageLimits(
    value: unknown,
    path: string
): Either<readonly RallarValidationIssue[], ALPublicationStageLimits> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return Either.ofLeft([{
            path,
            code: 'invalid-publication-limits',
            message: 'Expected a publication stage limits object.'
        }]);
    }
    const limits: ALPublicationStageLimits = {
        maxStreams: getOwnNumber(value, ['maxStreams'], Number.NaN),
        maxStagedValues: getOwnNumber(value, ['maxStagedValues'], Number.NaN),
        maxStagedBytes: getOwnNumber(value, ['maxStagedBytes'], Number.NaN)
    };
    const issues = [...validateLimitFields(limits, path), ...validateKnownFields(value, path)];
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(limits);
}

function validateLimitFields(limits: ALPublicationStageLimits, path: string): readonly RallarValidationIssue[] {
    return LIMIT_FIELDS.flatMap((field) =>
        isPositiveSafeInteger(limits[field])
            ? []
            : [{
                path: `${path}.${field}`,
                code: LIMIT_FIELD_CODES[field],
                message: 'Expected a positive safe integer.'
            }]
    );
}

function validateKnownFields(value: object, path: string): readonly RallarValidationIssue[] {
    return Object.keys(value).filter((field) => !Object.hasOwn(LIMIT_FIELD_CODES, field)).map((field) => ({
        path: `${path}.${field}`,
        code: 'unknown-field',
        message: 'Expected only maxStreams, maxStagedValues and maxStagedBytes.'
    }));
}

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 1;
}
