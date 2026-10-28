import { Either } from '../../resilience/Either.ts';

const AL_TRACE_ID_MAX_LENGTH = 128;
const AL_TRACE_ID_CHARACTER_CLASS = 'A-Za-z0-9_-';

export const AL_TRACE_ID_PATTERN = new RegExp(`^[${AL_TRACE_ID_CHARACTER_CLASS}]{1,${AL_TRACE_ID_MAX_LENGTH}}$`);

const AL_TRACE_ID_FOREIGN_CHARACTER = new RegExp(`[^${AL_TRACE_ID_CHARACTER_CLASS}]`);

export interface ALTraceIdIssue {
    readonly path: '$.traceId';
    readonly code: 'missing' | 'malformed';
    readonly message: string;
}

export function newALTraceId(): string {
    return crypto.randomUUID();
}

export function validateALTraceId(value: string): readonly ALTraceIdIssue[] {
    if (AL_TRACE_ID_PATTERN.test(value)) {
        return [];
    }
    const issues: ALTraceIdIssue[] = [];
    if (value.length === 0 || value.length > AL_TRACE_ID_MAX_LENGTH) {
        issues.push(toMalformedTraceIdIssue(`Trace id must be 1 to ${AL_TRACE_ID_MAX_LENGTH} characters`));
    }
    if (AL_TRACE_ID_FOREIGN_CHARACTER.test(value)) {
        issues.push(toMalformedTraceIdIssue('Trace id must contain only letters, digits, underscores or hyphens'));
    }
    return issues;
}

export function decodeALTraceId(value: unknown): Either<ALTraceIdIssue, string> {
    if (value === undefined) {
        return Either.ofLeft({ path: '$.traceId', code: 'missing', message: 'Trace id is required' });
    }
    if (typeof value !== 'string') {
        return Either.ofLeft(toMalformedTraceIdIssue('Trace id must be a string'));
    }
    const issues = validateALTraceId(value);
    return issues.length === 0 ? Either.ofRight(value) : Either.ofLeft(issues[0]);
}

function toMalformedTraceIdIssue(message: string): ALTraceIdIssue {
    return { path: '$.traceId', code: 'malformed', message };
}
