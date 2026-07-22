export interface AppInboxFailureIssue {
    readonly code: string;
    readonly path: readonly (string | number)[] | null;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>> | null;
}

export interface AppInboxFailureDenial {
    readonly code: string;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>> | null;
}

export interface AppInboxFailureRetry {
    readonly kind: 'unavailable' | 'exhausted';
    readonly attempts: number | null;
    readonly lane: string | null;
    readonly queueAgeMs: number | null;
    readonly dueAgeMs: number | null;
}

export interface AppInboxFailure {
    readonly type: 'app-inbox-failure';
    readonly code: string;
    readonly status: number;
    readonly message: string;
    readonly issues: readonly AppInboxFailureIssue[] | null;
    readonly denial: AppInboxFailureDenial | null;
    readonly retry: AppInboxFailureRetry | null;
}

export { readAppInboxFailure, readPersistedAppInboxFailure } from './app-inbox-failure-decoding.ts';

export function toTerminalAppInboxFailure(
    error: unknown,
    code: string,
): AppInboxFailure {
    const message = error instanceof Error ? error.message : String(error);
    const status = readErrorStatus(error, 400);
    return {
        type: 'app-inbox-failure',
        code,
        status,
        message,
        issues: readErrorIssues(error),
        denial: status === 403
            ? {
                code,
                message,
                details: readErrorDetails(error),
            }
            : null,
        retry: null,
    };
}

export function toPolicyDeniedAppInboxFailure(
    input: Readonly<{
        code: string;
        message: string;
        details: Readonly<Record<string, unknown>> | undefined;
    }>,
): AppInboxFailure {
    return {
        type: 'app-inbox-failure',
        code: input.code,
        status: 403,
        message: input.message,
        issues: null,
        denial: {
            code: input.code,
            message: input.message,
            details: input.details ?? null,
        },
        retry: null,
    };
}

export function toUnavailableAppInboxFailure(): AppInboxFailure {
    return {
        type: 'app-inbox-failure',
        code: 'app-inbox-unavailable',
        status: 503,
        message: 'App inbox entry did not complete within the wait budget',
        issues: null,
        denial: null,
        retry: {
            kind: 'unavailable',
            attempts: null,
            lane: null,
            queueAgeMs: null,
            dueAgeMs: null,
        },
    };
}

function readErrorStatus(error: unknown, fallback: number): number {
    if (!isRecord(error) || !Number.isInteger(error.status)) {
        return fallback;
    }
    const status = Number(error.status);
    return status >= 400 && status <= 599 ? status : fallback;
}

function readErrorIssues(error: unknown): readonly AppInboxFailureIssue[] | null {
    if (!isRecord(error) || !Array.isArray(error.issues)) {
        return null;
    }
    return error.issues.map((value) => toFailureIssue(value));
}

function toFailureIssue(value: unknown): AppInboxFailureIssue {
    if (!isRecord(value)) {
        return {
            code: 'invalid-issue',
            path: null,
            message: 'Validation issue metadata is malformed',
            details: null,
        };
    }
    return {
        code: typeof value.code === 'string' ? value.code : 'invalid-issue',
        path: Array.isArray(value.path) &&
                value.path.every((part) => typeof part === 'string' || typeof part === 'number')
            ? value.path as readonly (string | number)[]
            : null,
        message: typeof value.message === 'string'
            ? value.message
            : 'Validation issue metadata is malformed',
        details: isRecord(value.details) ? value.details : null,
    };
}

function readErrorDetails(error: unknown): Readonly<Record<string, unknown>> | null {
    if (!isRecord(error)) {
        return null;
    }
    if (isRecord(error.details)) {
        return error.details;
    }
    if (isRecord(error.denial) && isRecord(error.denial.details)) {
        return error.denial.details;
    }
    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
