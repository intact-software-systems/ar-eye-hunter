import { decodeAuthMutationResult } from '@shared-server/mod.ts';
import type { AdminPruneCommand } from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-command-codec.ts';
import { decodeAdminPruneEnqueueResultForCommand } from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-inbox-codec.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { decodePersistedAppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure-decoding.ts';
import * as CrdtResult from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';
import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';
import type { RallarCrdtJsonValue } from '@shared/crdt/mod.ts';

import {
    publicResultIdentityMatches,
    type PublicResultReceiptIdentity
} from './api-v1-state-write-group-causal-evidence.ts';
import { validateTopologyMutationResultPayload } from './validate-topology-mutation-result-payload.ts';

interface ResultEvidence {
    readonly valid: boolean;
    readonly result: ApiJsonValue | undefined;
    readonly receipt?: ResultEvidenceReceipt;
    readonly failure?: string;
}

interface ResultEvidenceReceipt {
    readonly commandId: string;
    readonly outboxIds: readonly string[];
    readonly identityKind: ReceiptEffectIdentityKind;
    readonly commandHash?: string;
    readonly outcome?: string;
}

interface ValidatePersistedAppInboxResultInput {
    readonly commandType: string;
    readonly commandIds: readonly string[];
    readonly resultStatus: string;
    readonly resultResource: string | null;
    readonly authoritativeReceipt?: AuthoritativeResultReceipt;
    readonly commandScope?: Readonly<{
        applicationId: string;
        workspaceId: string;
        groupId?: string;
    }>;
    readonly adminPruneCommand?: AdminPruneCommand;
    readonly requireAuthoritativeReceipt?: boolean;
}

interface ValidateReceiptResultInput {
    readonly receipt: ApiJsonObject;
    readonly commandIds: readonly string[];
    readonly identityKind: ReceiptEffectIdentityKind;
    readonly result?: ApiJsonObject;
}

interface ValidatePublicResultIdentityInput {
    readonly result: ApiJsonObject;
    readonly receipt: AuthoritativeResultReceipt;
    readonly kind: 'client' | 'group';
    readonly commandType: string;
}

export interface AuthoritativeResultReceipt extends PublicResultReceiptIdentity {
    readonly commandId: string;
    readonly commandHash: string;
    readonly outcome: string;
    readonly outboxIds: readonly string[];
    readonly identityKind: ReceiptEffectIdentityKind;
    readonly topology?: AuthoritativeTopologyReceipt;
}

export interface AuthoritativeTopologyReceipt {
    readonly operation: string;
    readonly target: 'config' | 'override';
    readonly groupRef: Readonly<{
        applicationId: string;
        workspaceId: string;
        groupId: string;
    }>;
    readonly acceptedVersion: number;
    readonly acceptedStorageRevision: number | null;
    readonly acceptedCreatedAtEpochMs: number | null;
    readonly acceptedUpdatedAtEpochMs: number | null;
    readonly acceptedExpiresAtEpochMs: number | null;
    readonly acceptedConfig: ApiJsonValue;
}

/** The group commands whose durable result is their receipt alone, with no snapshot to compare. */
const GROUP_RECEIPT_RESULT_COMMAND_TYPES: ReadonlySet<string> = new Set([
    AppInboxType.GROUP_PRESENCE_CONNECT,
    AppInboxType.GROUP_PRESENCE_HEARTBEAT,
    AppInboxType.GROUP_PRESENCE_DISCONNECT,
    AppInboxType.GROUP_PRESENCE_EXPIRE,
    AppInboxType.GROUP_TOPIC_SUBSCRIBE,
    AppInboxType.GROUP_TOPIC_UNSUBSCRIBE
]);

export type ReceiptEffectIdentityKind = 'logical-msg-id' | 'physical-resource-id';

export function validatePersistedAppInboxResult(
    input: ValidatePersistedAppInboxResultInput
): ResultEvidence {
    if (!['COMPLETED', 'FAILED'].includes(input.resultStatus)) {
        return invalid(undefined, 'missing-result-status');
    }
    const parsedResult = parseResult(input.resultResource);
    if (input.resultStatus === 'COMPLETED' && input.commandType === 'CLIENT_EXPIRED_SESSIONS') {
        return Array.isArray(parsedResult) && parsedResult.every(validateClientWritten)
            ? { valid: true, result: parsedResult }
            : invalid(parsedResult, 'malformed-client-expiry-result');
    }
    const result = record(parsedResult);
    if (!result) {
        return invalid(parsedResult, 'malformed-result-resource');
    }
    if (input.resultStatus === 'FAILED') {
        const failure = decodePersistedAppInboxFailure(input.resultResource ?? '');
        return failure.code !== 'app-inbox-persisted-failure-corrupt'
            ? { valid: true, result }
            : invalid(result, 'malformed-failure-result');
    }
    if (input.commandType.startsWith('CLIENT_')) {
        if (
            input.commandType === 'CLIENT_AUTHORISED_WS_CONNECT' &&
            exactKeys(result, ['status', 'sessionId', 'generationId']) &&
            result.status === 'inactive' &&
            nonEmptyString(result.sessionId) &&
            nonEmptyString(result.generationId)
        ) {
            return { valid: true, result };
        }
        if (
            input.commandType === 'CLIENT_AUTHORISED_WS_DISCONNECT' &&
            exactKeys(result, ['status', 'generationId']) &&
            result.status === 'inactive' &&
            nonEmptyString(result.generationId)
        ) {
            return { valid: true, result };
        }
        if (!validateClientWritten(result)) {
            return invalid(result, 'malformed-client-result');
        }
        return input.authoritativeReceipt
            ? validatePublicResultIdentity({
                result,
                receipt: input.authoritativeReceipt,
                kind: 'client',
                commandType: input.commandType
            })
            : !input.requireAuthoritativeReceipt
            ? { valid: true, result }
            : invalid(result, 'missing-authoritative-client-receipt');
    }
    if (input.commandType === 'GROUP_PRESENCE_SESSION_CLEANUP') {
        return exactKeys(result, ['status', 'sessionId', 'generationId', 'affectedGroups']) &&
                result.status === 'inactive' &&
                nonEmptyString(result.sessionId) !== undefined &&
                input.commandIds.includes(String(result.sessionId)) &&
                nonEmptyString(result.generationId) !== undefined &&
                input.commandIds.includes(String(result.generationId)) &&
                Number.isSafeInteger(result.affectedGroups) &&
                Number(result.affectedGroups) >= 0
            ? { valid: true, result }
            : invalid(result, 'malformed-group-session-cleanup-result');
    }
    if (GROUP_RECEIPT_RESULT_COMMAND_TYPES.has(input.commandType)) {
        return validateEmbeddedAuthoritativeReceipt(
            validateReceiptResult({
                receipt: result,
                commandIds: input.commandIds,
                identityKind: 'physical-resource-id'
            }),
            input.authoritativeReceipt,
            input.requireAuthoritativeReceipt ?? false
        );
    }
    if (
        input.commandType.startsWith('TOPOLOGY_CONFIG_') ||
        input.commandType.startsWith('TOPOLOGY_OVERRIDE_')
    ) {
        const receipt = record(result.receipt);
        if (!receipt) {
            return invalid(result, 'missing-topology-receipt');
        }
        const embedded = validateEmbeddedAuthoritativeReceipt(
            validateReceiptResult({
                receipt,
                commandIds: input.commandIds,
                identityKind: 'logical-msg-id',
                result
            }),
            input.authoritativeReceipt,
            input.requireAuthoritativeReceipt ?? false
        );
        if (!embedded.valid) {
            return embedded;
        }
        const payloadFailure = validateTopologyMutationResultPayload(
            input.commandType,
            result,
            input.authoritativeReceipt?.topology
        );
        return payloadFailure ? invalid(result, payloadFailure) : embedded;
    }
    if (input.commandType === 'TOPOLOGY_RECONFIGURE') {
        const requestId = readMatchingId(result.requestId, input.commandIds);
        const outboxId = nonEmptyString(result.outboxId);
        const groupRef = record(result.groupRef);
        const scopeMatches = groupRef &&
            input.commandScope &&
            exactKeys(groupRef, ['applicationId', 'workspaceId', 'groupId']) &&
            groupRef.applicationId === input.commandScope.applicationId &&
            groupRef.workspaceId === input.commandScope.workspaceId &&
            groupRef.groupId === input.commandScope.groupId;
        return exactKeys(result, ['status', 'groupRef', 'requestId', 'outboxId']) &&
                result.status === 'queued' &&
                requestId &&
                outboxId &&
                scopeMatches
            ? {
                valid: true,
                result,
                receipt: {
                    commandId: requestId,
                    outboxIds: [outboxId],
                    identityKind: 'logical-msg-id'
                }
            }
            : invalid(result, 'malformed-topology-reconfigure-result');
    }
    if (input.commandType.startsWith('GROUP_')) {
        const written = record(result.result);
        const validStatus = ['ok', 'created'].includes(String(result.status));
        const validWritten = written !== undefined &&
            record(written.snapshot) !== undefined &&
            Object.hasOwn(written, 'event');
        if (!validStatus || !validWritten) {
            return invalid(result, 'malformed-group-result');
        }
        if (input.authoritativeReceipt) {
            return validatePublicResultIdentity({
                result,
                receipt: input.authoritativeReceipt,
                kind: 'group',
                commandType: input.commandType
            });
        }
        return input.requireAuthoritativeReceipt
            ? invalid(result, 'missing-authoritative-group-receipt')
            : { valid: true, result };
    }
    if (input.commandType.startsWith('AUTH_')) {
        try {
            const decoded = decodeAuthMutationResult(result);
            return readMatchingId(decoded.requestId, input.commandIds)
                ? { valid: true, result }
                : invalid(result, 'mismatched-auth-result');
        }
        catch {
            return invalid(result, 'malformed-auth-result');
        }
    }
    if (input.commandType.startsWith('CRDT_')) {
        try {
            const decoded = CrdtResult.decodeCrdtMutationResult(result);
            const commandId = readMatchingId(decoded.commandId, input.commandIds);
            return commandId ? { valid: true, result } : invalid(result, 'mismatched-crdt-result');
        }
        catch {
            return invalid(result, 'malformed-crdt-result');
        }
    }
    if (input.commandType === 'ADMIN_PRUNE_EXPIRED') {
        if (input.adminPruneCommand === undefined) {
            return invalid(result, 'missing-admin-prune-command');
        }
        try {
            decodeAdminPruneEnqueueResultForCommand(
                result as RallarCrdtJsonValue,
                input.adminPruneCommand
            );
            return { valid: true, result };
        }
        catch {
            return invalid(result, 'malformed-admin-prune-result');
        }
    }
    if (input.commandType === 'RTC_RTT_SUBMIT') {
        return validateRtcRttResult(result, input.commandIds)
            ? { valid: true, result }
            : invalid(result, 'malformed-rtc-rtt-result');
    }
    return invalid(result, 'unsupported-command-result');
}

function validatePublicResultIdentity(input: ValidatePublicResultIdentityInput): ResultEvidence {
    const { result, receipt, kind, commandType } = input;
    if (!publicResultIdentityMatches(result, receipt, kind, commandType)) {
        return invalid(result, `mismatched-${kind}-result-receipt-identity`);
    }
    return { valid: true, result, receipt: toResultReceipt(receipt) };
}

function validateEmbeddedAuthoritativeReceipt(
    embedded: ResultEvidence,
    authoritative: AuthoritativeResultReceipt | undefined,
    required: boolean
): ResultEvidence {
    if (!embedded.valid || !embedded.receipt) {
        return embedded;
    }
    if (!authoritative) {
        return required ? invalid(embedded.result, 'missing-authoritative-receipt') : embedded;
    }
    return embedded.receipt.commandId === authoritative.commandId &&
            embedded.receipt.identityKind === authoritative.identityKind &&
            embedded.receipt.commandHash === authoritative.commandHash &&
            embedded.receipt.outcome === authoritative.outcome &&
            sameIds(embedded.receipt.outboxIds, authoritative.outboxIds)
        ? embedded
        : invalid(embedded.result, 'embedded-authoritative-receipt-mismatch');
}

function toResultReceipt(receipt: AuthoritativeResultReceipt): ResultEvidenceReceipt {
    return {
        commandId: receipt.commandId,
        outboxIds: [...receipt.outboxIds],
        identityKind: receipt.identityKind,
        commandHash: receipt.commandHash,
        outcome: receipt.outcome
    };
}

function validateClientWritten(value: ApiJsonValue): boolean {
    const result = record(value);
    const written = record(result?.result);
    return Boolean(
        result &&
            exactKeys(result, ['status', 'result']) &&
            result.status === 'ok' &&
            written &&
            exactKeys(written, ['snapshot', 'event']) &&
            record(written.snapshot) &&
            (written.event === null || record(written.event))
    );
}

function validateRtcRttResult(result: ApiJsonObject, commandIds: readonly string[]): boolean {
    return (
        exactKeys(result, ['requestId', 'accepted', 'reason', 'affectedGroups', 'updated']) &&
        readMatchingId(result.requestId, commandIds) !== undefined &&
        typeof result.accepted === 'boolean' &&
        nonEmptyString(result.reason) !== undefined &&
        Array.isArray(result.affectedGroups) &&
        result.affectedGroups.every((group) => record(group) !== undefined) &&
        typeof result.updated === 'boolean'
    );
}

function validateReceiptResult(input: ValidateReceiptResultInput): ResultEvidence {
    const { receipt, commandIds, identityKind } = input;
    const result = input.result ?? receipt;
    const allowedKeys = identityKind === 'physical-resource-id'
        ? [
            'commandId',
            'requestId',
            'commandHash',
            'aggregateRef',
            'outcome',
            'attemptCount',
            'acceptedStorageRevision',
            'snapshotVersion',
            'causalRevision',
            'eventId',
            'outboxIds',
            'joinCode',
            'joinCodeExpiresAtEpochMs',
            'subscriptionOutcome',
            'rejection'
        ]
        : [
            'commandId',
            'requestId',
            'commandHash',
            'operation',
            'outcome',
            'attemptCount',
            'groupRef',
            'target',
            'acceptedVersion',
            'acceptedStorageRevision',
            'acceptedCreatedAtEpochMs',
            'acceptedUpdatedAtEpochMs',
            'acceptedExpiresAtEpochMs',
            'acceptedConfig',
            'acceptedCausalRevision',
            'eventId',
            'outboxIds'
        ];
    const commandId = readMatchingId(receipt.commandId, commandIds);
    const outboxIds = readUniqueIds(receipt.outboxIds);
    const commandHash = nonEmptyString(receipt.commandHash);
    const outcome = nonEmptyString(receipt.outcome);
    if (
        !exactKeys(receipt, allowedKeys) ||
        !commandId ||
        !outboxIds ||
        typeof receipt.outcome !== 'string' ||
        !Number.isSafeInteger(receipt.attemptCount)
    ) {
        return invalid(result, 'malformed-or-mismatched-receipt');
    }
    return {
        valid: true,
        result,
        receipt: {
            commandId,
            outboxIds,
            identityKind,
            ...(commandHash ? { commandHash } : {}),
            ...(outcome ? { outcome } : {})
        }
    };
}

/** JSON.parse yields JSON values only, so its result is a JSON value by construction. */
function parseResult(value: string | null): ApiJsonValue | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    try {
        return JSON.parse(value) as ApiJsonValue;
    }
    catch {
        return undefined;
    }
}

function record(value: ApiJsonValue | undefined): ApiJsonObject | undefined {
    return value !== null && typeof value === 'object' && !isJsonArray(value) ? value : undefined;
}

function isJsonArray(value: ApiJsonValue): value is readonly ApiJsonValue[] {
    return Array.isArray(value);
}

function nonEmptyString(value: ApiJsonValue | undefined): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readMatchingId(value: ApiJsonValue | undefined, commandIds: readonly string[]): string | undefined {
    const id = nonEmptyString(value);
    return id && commandIds.includes(id) ? id : undefined;
}

function readUniqueIds(value: ApiJsonValue | undefined): readonly string[] | undefined {
    if (value === undefined || !isJsonArray(value)) {
        return undefined;
    }
    const ids = value.flatMap((id) => (typeof id === 'string' && id.length > 0 ? [id] : []));
    return ids.length === value.length && new Set(ids).size === ids.length ? ids : undefined;
}

function exactKeys(value: ApiJsonObject, keys: readonly string[]): boolean {
    return JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...keys].toSorted());
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
    return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function invalid(result: ApiJsonValue | undefined, failure: string): ResultEvidence {
    return { valid: false, result, failure };
}
