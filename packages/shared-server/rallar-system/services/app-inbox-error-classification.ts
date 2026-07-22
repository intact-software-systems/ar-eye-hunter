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

const RETRYABLE_CONFLICT_CODES = new Set([
    'app-inbox-reservation-conflict',
    'resource-inbox-lost-reservation',
    'runtime-state-write-conflict',
    'state-snapshot-read-conflict',
    'group-topology-commit-conflict',
]);

const RETRYABLE_CODES = new Set([
    ...RETRYABLE_CONFLICT_CODES,
    'app-inbox-transient',
]);

const TERMINAL_CODES = new Set([
    'app-inbox-malformed-command',
    'app-inbox-idempotency-conflict',
    'app-inbox-lifecycle-rejected',
    'client-mutation-idempotency-conflict',
    'client-mutation-rejected',
    'client-state-event-repository-invariant-corruption',
    'client-state-repository-invariant-corruption',
    'group-mutation-authority-denied',
    'group-mutation-idempotency-conflict',
    'group-mutation-rejected',
    'group-state-event-collision',
    'group-state-event-repository-invariant-corruption',
    'group-state-repository-invariant-corruption',
    'group-topology-config-idempotency-conflict',
    'group-topology-config-repository-invariant-corruption',
    'group-topology-config-validation-failed',
    'group-topology-validation-failed',
    'resource-inbox-invariant-corruption',
    'rtc-rtt-idempotency-conflict',
    'rtc-topology-publication-collision',
    'rtc-topology-repository-invariant-corruption',
    'state-mutation-outbox-collision',
    'state-mutation-outbox-invariant-corruption',
]);

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
    if (TERMINAL_CODES.has(code)) {
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
    if (RETRYABLE_CONFLICT_CODES.has(code)) {
        return 'AppInbox processing encountered a retryable conflict';
    }
    return 'AppInbox processing encountered a retryable transient failure';
}

function toTerminalResult(error: unknown, code: string): unknown {
    const message = error instanceof Error ? error.message : String(error);
    const status = error && typeof error === 'object' && 'status' in error &&
            typeof error.status === 'number'
        ? error.status
        : 400;
    return { error: message, code, message, status };
}
