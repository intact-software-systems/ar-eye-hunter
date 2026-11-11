import { getOwnNumber } from '../../api/exact-object-decoding.ts';
import type { RallarValidationIssue } from '../../api/rallar-validation.ts';
import { Either } from '../../resilience/Either.ts';
import {
    AL_VOLATILE_SESSION_MAX_AGE_MS,
    AL_VOLATILE_SESSION_MAX_TRACKS,
    type ALVolatileSessionLimits
} from './al-volatile-session-budget.ts';

const LIMIT_FIELDS = ['maxAdmissions', 'maxBytes', 'maxAgeMs', 'maxTracks'] as const;

const LIMIT_FIELD_CODES: Readonly<Record<keyof ALVolatileSessionLimits, string>> = {
    maxAdmissions: 'invalid-max-admissions',
    maxBytes: 'invalid-max-bytes',
    maxAgeMs: 'invalid-max-age-ms',
    maxTracks: 'invalid-max-tracks'
};

/** The count and byte bounds are required; an age or track bound left out reads its constant (D179). Issues name `path`. */
export function decodeALVolatileSessionLimits(
    value: unknown,
    path: string
): Either<readonly RallarValidationIssue[], ALVolatileSessionLimits> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return Either.ofLeft([{
            path,
            code: 'invalid-volatile-limits',
            message: 'Expected a volatile session limits object.'
        }]);
    }
    const limits: ALVolatileSessionLimits = {
        maxAdmissions: getOwnNumber(value, ['maxAdmissions'], Number.NaN),
        maxBytes: getOwnNumber(value, ['maxBytes'], Number.NaN),
        maxAgeMs: getOwnNumber(value, ['maxAgeMs'], AL_VOLATILE_SESSION_MAX_AGE_MS),
        maxTracks: getOwnNumber(value, ['maxTracks'], AL_VOLATILE_SESSION_MAX_TRACKS)
    };
    const issues = [...validateLimitFields(limits, path), ...validateKnownFields(value, path)];
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(limits);
}

function validateLimitFields(limits: ALVolatileSessionLimits, path: string): readonly RallarValidationIssue[] {
    return LIMIT_FIELDS.flatMap((field) =>
        Number.isSafeInteger(limits[field]) && limits[field] >= 1
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
        message: 'Expected only maxAdmissions, maxBytes, maxAgeMs and maxTracks.'
    }));
}
