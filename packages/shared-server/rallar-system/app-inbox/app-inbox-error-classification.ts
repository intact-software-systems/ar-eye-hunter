import type { GroupTopologyValidationIssue } from '@shared/api/graph-topology-management-types.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
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
        code: string;
        result: AppInboxFailure;
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
    'group-topology-commit-conflict'
]);

const RETRYABLE_CODES = new Set([...RETRYABLE_CONFLICT_CODES, 'app-inbox-transient']);

const TERMINAL_STATUS_BY_CODE = new Map<string, number>([
    ['app-inbox-malformed-command', 400],
    ['app-inbox-idempotency-conflict', 409],
    ['app-inbox-lifecycle-rejected', 409],
    ['client-mutation-idempotency-conflict', 409],
    ['client-mutation-rejected', 400],
    ['client-state-event-collision', 409],
    ['client-state-event-repository-invariant-corruption', 500],
    ['client-state-repository-invariant-corruption', 500],
    ['admin-prune-authority-denied', 403],
    ['crdt-authority-denied', 403],
    ['group-mutation-authority-denied', 403],
    ['group-already-exists', 409],
    ['group-mutation-idempotency-conflict', 409],
    ['group-mutation-rejected', 400],
    ['group-state-event-collision', 409],
    ['group-state-event-repository-invariant-corruption', 500],
    ['group-state-repository-invariant-corruption', 500],
    ['group-topology-config-idempotency-conflict', 409],
    ['group-topology-config-repository-invariant-corruption', 500],
    ['resource-inbox-invariant-corruption', 500],
    ['rtc-rtt-idempotency-conflict', 409],
    ['rtc-topology-publication-collision', 409],
    ['rtc-topology-repository-invariant-corruption', 500],
    ['state-mutation-outbox-collision', 409],
    ['state-mutation-outbox-invariant-corruption', 500]
]);

interface FailureDenialInput {
    readonly code: string;
    readonly status: number;
    readonly message: string;
    readonly details: JsonWireObject | null;
}

export function classifyAppInboxError(error: unknown): AppInboxErrorClassification {
    const code = toAppInboxErrorCode(error);
    if (error instanceof AppInboxReservationConflictError || RETRYABLE_CODES.has(code)) {
        return toRetryableClassification(code);
    }
    if (isGroupPolicyDeniedError(error)) {
        return toTerminalClassification(toGroupPolicyFailure(error));
    }
    if (error instanceof GroupTopologyConfigValidationError || error instanceof GroupTopologyValidationError) {
        return toTerminalClassification(toTopologyValidationFailure(error));
    }
    if (error instanceof AdminPruneValidationError) {
        return toTerminalClassification(toAdminPruneValidationFailure(error));
    }
    if (error instanceof CrdtHttpAdminRejectionError) {
        return toTerminalClassification(toCrdtAdminRejectionFailure(error));
    }
    if (error instanceof AuthMutationRejectedError || error instanceof GroupConnectDeniedError) {
        return toTerminalClassification(toExplicitStatusFailure(error, error.code, error.status));
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
        return toMalformedCommandClassification();
    }
    if (error instanceof NonRetryableException) {
        return toTerminalClassification(
            toExplicitStatusFailure(error, 'app-inbox-non-retryable', 400)
        );
    }
    const terminalStatus = TERMINAL_STATUS_BY_CODE.get(code);
    if (terminalStatus !== undefined) {
        return toTerminalClassification(toExplicitStatusFailure(error, code, terminalStatus));
    }
    return toRetryableClassification(code);
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

function toTerminalClassification(result: AppInboxFailure): AppInboxErrorClassification {
    return { kind: 'terminal', code: result.code, result };
}

function toMalformedCommandClassification(): AppInboxErrorClassification {
    const code = 'app-inbox-malformed-command';
    return toTerminalClassification(toTerminalAppInboxFailure({
        code,
        status: 400,
        message: 'App inbox command is malformed'
    }));
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
