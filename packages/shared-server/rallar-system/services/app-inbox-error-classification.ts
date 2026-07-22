import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { isGroupPolicyDeniedError } from '../group-policy.ts';
import { AppInboxReservationConflictError } from './app-inbox-contracts.ts';

export type AppInboxErrorClassification =
    | Readonly<{
        kind: 'terminal';
        code: string;
        result: unknown;
    }>
    | Readonly<{
        kind: 'retryable';
        code: string;
        message: string;
    }>;

const RETRYABLE_CODES = new Set([
    'app-inbox-reservation-conflict',
    'resource-inbox-lost-reservation',
    'runtime-state-write-conflict',
    'state-snapshot-read-conflict',
    'group-topology-commit-conflict',
    'app-inbox-transient',
]);

const TERMINAL_CODE_PARTS = [
    'authority-denied',
    'policy-denied',
    'malformed',
    'rejected',
    'validation',
    'idempotency-conflict',
    'collision',
    'invariant-corruption',
    'lifecycle',
] as const;

export function classifyAppInboxError(error: unknown): AppInboxErrorClassification {
    const code = toAppInboxErrorCode(error);
    if (
        error instanceof AppInboxReservationConflictError ||
        RETRYABLE_CODES.has(code)
    ) {
        return {
            kind: 'retryable',
            code,
            message: toRetryableAppInboxMessage(code),
        };
    }
    if (isGroupPolicyDeniedError(error)) {
        return {
            kind: 'terminal',
            code: error.denial.code,
            result: {
                error: error.message,
                code: error.denial.code,
                message: error.denial.message,
                details: error.denial.details,
            },
        };
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
        return {
            kind: 'terminal',
            code: 'app-inbox-malformed-command',
            result: {
                error: 'App inbox command is malformed',
                code: 'app-inbox-malformed-command',
                message: 'App inbox command is malformed',
                status: 400,
            },
        };
    }
    if (error instanceof NonRetryableException) {
        return {
            kind: 'terminal',
            code: 'app-inbox-non-retryable',
            result: error.message,
        };
    }
    if (isExplicitTerminalCode(code)) {
        return {
            kind: 'terminal',
            code,
            result: toTerminalResult(error, code),
        };
    }
    return {
        kind: 'retryable',
        code,
        message: toRetryableAppInboxMessage(code),
    };
}

export function toAppInboxErrorCode(error: unknown): string {
    return error && typeof error === 'object' && 'code' in error &&
            typeof error.code === 'string'
        ? error.code
        : error instanceof Error
        ? error.name
        : 'unknown-error';
}

export function toRetryableAppInboxMessage(code: string): string {
    if (code.includes('conflict') || code === 'resource-inbox-lost-reservation') {
        return 'AppInbox processing encountered a retryable conflict';
    }
    return 'AppInbox processing encountered a retryable transient failure';
}

function isExplicitTerminalCode(code: string): boolean {
    return TERMINAL_CODE_PARTS.some((part) => code.includes(part));
}

function toTerminalResult(error: unknown, code: string): unknown {
    const message = error instanceof Error ? error.message : String(error);
    const status = error && typeof error === 'object' && 'status' in error &&
            typeof error.status === 'number'
        ? error.status
        : 400;
    return { error: message, code, message, status };
}
