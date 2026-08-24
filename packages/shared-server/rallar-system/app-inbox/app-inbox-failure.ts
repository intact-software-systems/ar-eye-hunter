import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../protocol/json-wire-identity.ts';

export interface AppInboxFailureIssue {
    readonly code: string;
    readonly path: readonly (string | number)[] | null;
    readonly message: string;
    readonly details: JsonWireObject | null;
}

export interface AppInboxFailureDenial {
    readonly code: string;
    readonly message: string;
    readonly details: JsonWireObject | null;
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

export interface TerminalAppInboxFailureInput {
    readonly code: string;
    readonly status: number;
    readonly message: string;
    readonly issues?: readonly AppInboxFailureIssue[];
    readonly denial?: AppInboxFailureDenial;
}

export function encodeAppInboxFailure(failure: AppInboxFailure): JsonWireValue {
    return decodeJsonWireValue(failure, 'AppInbox failure');
}

export function toTerminalAppInboxFailure(
    input: TerminalAppInboxFailureInput
): AppInboxFailure {
    return {
        type: 'app-inbox-failure',
        code: input.code,
        status: input.status,
        message: input.message,
        issues: input.issues ?? null,
        denial: input.denial ?? null,
        retry: null
    };
}

export function toPolicyDeniedAppInboxFailure(
    denial: AppInboxFailureDenial
): AppInboxFailure {
    return {
        type: 'app-inbox-failure',
        code: denial.code,
        status: 403,
        message: denial.message,
        issues: null,
        denial,
        retry: null
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
            dueAgeMs: null
        }
    };
}

export function toUnexpectedAppInboxFailure(): AppInboxFailure {
    return {
        type: 'app-inbox-failure',
        code: 'app-inbox-unexpected',
        status: 500,
        message: 'App inbox processing failed unexpectedly',
        issues: null,
        denial: null,
        retry: null
    };
}

export function toPersistedAppInboxFailureCorruption(): AppInboxFailure {
    return {
        type: 'app-inbox-failure',
        code: 'app-inbox-persisted-failure-corrupt',
        status: 500,
        message: 'Persisted AppInbox failure is corrupt',
        issues: null,
        denial: null,
        retry: null
    };
}
