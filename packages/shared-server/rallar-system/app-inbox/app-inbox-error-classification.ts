import type { GroupTopologyValidationIssue } from '@shared/api/graph-topology-management-types.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';

import { AdminPruneValidationError } from '../admin-operations/inbox/admin-prune-inbox-validation.ts';
import { AuthMutationRejectedError } from '../auth/mutation/auth-mutation-rejected-error.ts';
import { CrdtHttpAdminRejectionError } from '../crdt/inbox/crdt-http-admin-rejection-error.ts';
import { GroupConnectDeniedError } from '../group-state/mutation/group-mutation-rejection-codes.ts';
import { GroupPolicyDeniedError, isGroupPolicyDeniedError } from '../group-state/policy/group-policy-result.ts';
import { decodeJsonWireValue, type JsonWireObject } from '../protocol/json-wire-identity.ts';
import { GroupTopologyConfigValidationError } from '../topology/config/group-topology-config.ts';
import { GroupTopologyValidationError } from '../topology/group-topology-errors.ts';
import { AppInboxReservationConflictError } from './app-inbox-contracts.ts';
import {
    toPolicyDeniedAppInboxFailure,
    toTerminalAppInboxFailure,
    type AppInboxFailure,
    type AppInboxFailureDenial,
    type AppInboxFailureIssue
} from './app-inbox-failure.ts';

export type AppInboxErrorClassification =
    | Readonly<{
        kind: 'terminal';
        queueFailure: 'command-rejected' | 'operational';
        code: string;
        result: AppInboxFailure;
    }>
    | Readonly<{
        kind: 'retryable';
        code: string;
        message: string;
    }>;

interface TerminalAppInboxErrorPolicy {
    readonly status: number;
    readonly queueFailure: 'command-rejected' | 'operational';
}

interface FailureDenialInput {
    readonly code: string;
    readonly status: number;
    readonly message: string;
    readonly details: JsonWireObject | null;
}

const RETRYABLE_CONFLICT_CODES = new Set([
    'app-inbox-reservation-conflict',
    'resource-inbox-lost-reservation',
    'runtime-state-write-conflict',
    'state-snapshot-read-conflict',
    'group-topology-commit-conflict'
]);

const RETRYABLE_CODES = new Set([...RETRYABLE_CONFLICT_CODES, 'app-inbox-transient']);

const TERMINAL_POLICY_BY_CODE = new Map<string, TerminalAppInboxErrorPolicy>([
    ['app-inbox-malformed-command', { status: 400, queueFailure: 'operational' }],
    ['app-inbox-idempotency-conflict', { status: 409, queueFailure: 'command-rejected' }],
    ['app-inbox-lifecycle-rejected', { status: 409, queueFailure: 'command-rejected' }],
    ['client-mutation-idempotency-conflict', { status: 409, queueFailure: 'command-rejected' }],
    ['client-mutation-rejected', { status: 400, queueFailure: 'command-rejected' }],
    ['client-state-event-collision', { status: 409, queueFailure: 'operational' }],
    ['client-state-event-repository-invariant-corruption', { status: 500, queueFailure: 'operational' }],
    ['client-state-repository-invariant-corruption', { status: 500, queueFailure: 'operational' }],
    ['admin-prune-authority-denied', { status: 403, queueFailure: 'command-rejected' }],
    ['crdt-authority-denied', { status: 403, queueFailure: 'command-rejected' }],
    ['group-mutation-authority-denied', { status: 403, queueFailure: 'command-rejected' }],
    ['group-already-exists', { status: 409, queueFailure: 'command-rejected' }],
    ['group-mutation-idempotency-conflict', { status: 409, queueFailure: 'command-rejected' }],
    ['group-mutation-rejected', { status: 400, queueFailure: 'command-rejected' }],
    ['group-state-event-collision', { status: 409, queueFailure: 'operational' }],
    ['group-state-event-repository-invariant-corruption', { status: 500, queueFailure: 'operational' }],
    ['group-state-repository-invariant-corruption', { status: 500, queueFailure: 'operational' }],
    ['group-topology-config-idempotency-conflict', { status: 409, queueFailure: 'command-rejected' }],
    ['group-topology-config-repository-invariant-corruption', { status: 500, queueFailure: 'operational' }],
    ['resource-inbox-invariant-corruption', { status: 500, queueFailure: 'operational' }],
    ['rtc-rtt-idempotency-conflict', { status: 409, queueFailure: 'command-rejected' }],
    ['rtc-topology-publication-collision', { status: 409, queueFailure: 'operational' }],
    ['rtc-topology-repository-invariant-corruption', { status: 500, queueFailure: 'operational' }],
    ['state-mutation-outbox-collision', { status: 409, queueFailure: 'operational' }],
    ['state-mutation-outbox-invariant-corruption', { status: 500, queueFailure: 'operational' }]
]);

export function classifyAppInboxError(error: unknown): AppInboxErrorClassification {
    const code = toAppInboxErrorCode(error);
    if (error instanceof AppInboxReservationConflictError || RETRYABLE_CODES.has(code)) {
        return toRetryableClassification(code);
    }
    if (isGroupPolicyDeniedError(error)) {
        return toTerminalClassification(toGroupPolicyFailure(error), 'command-rejected');
    }
    if (error instanceof GroupTopologyConfigValidationError || error instanceof GroupTopologyValidationError) {
        return toTerminalClassification(toTopologyValidationFailure(error), 'command-rejected');
    }
    if (error instanceof AdminPruneValidationError) {
        return toTerminalClassification(toAdminPruneValidationFailure(error), 'command-rejected');
    }
    if (error instanceof CrdtHttpAdminRejectionError) {
        return toTerminalClassification(toCrdtAdminRejectionFailure(error), 'command-rejected');
    }
    if (error instanceof AuthMutationRejectedError || error instanceof GroupConnectDeniedError) {
        return toTerminalClassification(toExplicitStatusFailure(error, error.code, error.status), 'command-rejected');
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
        return toMalformedCommandClassification();
    }
    if (error instanceof NonRetryableException) {
        return toTerminalClassification(
            toExplicitStatusFailure(error, 'app-inbox-non-retryable', 400),
            'operational'
        );
    }
    const terminalPolicy = TERMINAL_POLICY_BY_CODE.get(code);
    if (terminalPolicy !== undefined) {
        return toTerminalClassification(
            toExplicitStatusFailure(error, code, terminalPolicy.status),
            terminalPolicy.queueFailure
        );
    }
    return toRetryableClassification(code);
}

/** An optimistic conflict is an expected typed outcome: redelivery retries it and it is never an operational failure. */
export function isAppInboxRetryableConflict(error: Error): boolean {
    return error instanceof AppInboxReservationConflictError ||
        RETRYABLE_CONFLICT_CODES.has(toAppInboxErrorCode(error));
}

export function toAppInboxErrorCode(error: unknown): string {
    return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
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

function toRetryableClassification(code: string): AppInboxErrorClassification {
    return {
        kind: 'retryable',
        code,
        message: toRetryableAppInboxMessage(code)
    };
}

function toTerminalClassification(
    result: AppInboxFailure,
    queueFailure: TerminalAppInboxErrorPolicy['queueFailure']
): AppInboxErrorClassification {
    return {
        kind: 'terminal',
        code: result.code,
        result,
        queueFailure: result.status >= 500 ? 'operational' : queueFailure
    };
}

function toMalformedCommandClassification(): AppInboxErrorClassification {
    const code = 'app-inbox-malformed-command';
    return toTerminalClassification(
        toTerminalAppInboxFailure({
            code,
            status: 400,
            message: 'App inbox command is malformed'
        }),
        'operational'
    );
}

function toGroupPolicyFailure(error: GroupPolicyDeniedError): AppInboxFailure {
    try {
        return toPolicyDeniedAppInboxFailure({
            code: error.denial.code,
            message: error.denial.message,
            details: decodeNullableFailureDetails(error.denial.details, 'Group policy denial details')
        });
    }
    catch {
        return toInvalidFailureMetadata();
    }
}

function toTopologyValidationFailure(
    error: GroupTopologyConfigValidationError | GroupTopologyValidationError
): AppInboxFailure {
    try {
        return toTerminalAppInboxFailure({
            code: error.code,
            status: error.status,
            message: error.message,
            issues: error.issues.map(toTopologyFailureIssue)
        });
    }
    catch {
        return toInvalidFailureMetadata();
    }
}

function toTopologyFailureIssue(issue: GroupTopologyValidationIssue): AppInboxFailureIssue {
    return {
        code: issue.code,
        path: issue.path ?? null,
        message: issue.message,
        details: decodeNullableFailureDetails(issue.details, 'Topology validation issue details')
    };
}

function toAdminPruneValidationFailure(error: AdminPruneValidationError): AppInboxFailure {
    const issues = error.issues.map((issue): AppInboxFailureIssue => ({
        code: issue.code,
        path: null,
        message: issue.message,
        details: null
    }));
    const denial = toFailureDenial({
        code: error.code,
        status: error.status,
        message: error.message,
        details: null
    });
    return toTerminalAppInboxFailure({
        code: error.code,
        status: error.status,
        message: error.message,
        issues,
        ...(denial ? { denial } : {})
    });
}

function toCrdtAdminRejectionFailure(error: CrdtHttpAdminRejectionError): AppInboxFailure {
    const denial = toFailureDenial({
        code: error.code,
        status: error.status,
        message: error.message,
        details: error.details
    });
    return toTerminalAppInboxFailure({
        code: error.code,
        status: error.status,
        message: error.message,
        ...(denial ? { denial } : {})
    });
}

function toExplicitStatusFailure(error: unknown, code: string, status: number): AppInboxFailure {
    const message = error instanceof Error ? error.message : String(error);
    const denial = toFailureDenial({ code, status, message, details: null });
    return toTerminalAppInboxFailure({
        code,
        status,
        message,
        ...(denial ? { denial } : {})
    });
}

function toFailureDenial(input: FailureDenialInput): AppInboxFailureDenial | undefined {
    return input.status === 401 || input.status === 403
        ? { code: input.code, message: input.message, details: input.details }
        : undefined;
}

function decodeNullableFailureDetails(
    value: unknown,
    label: string
): JsonWireObject | null {
    if (value === undefined || value === null) {
        return null;
    }
    const decoded = decodeJsonWireValue(value, label);
    if (!isJsonWireObject(decoded)) {
        throw new TypeError(`${label} must be a JSON object`);
    }
    return decoded;
}

function isJsonWireObject(value: ReturnType<typeof decodeJsonWireValue>): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toInvalidFailureMetadata(): AppInboxFailure {
    return toTerminalAppInboxFailure({
        code: 'app-inbox-failure-metadata-invalid',
        status: 500,
        message: 'AppInbox failure metadata is not JSON-safe'
    });
}
