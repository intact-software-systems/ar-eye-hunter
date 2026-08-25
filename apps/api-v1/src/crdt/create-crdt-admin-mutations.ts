import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import type {
    CrdtAdminCompactResult,
    CrdtAdminEraseResult,
    CrdtMutationActor,
    CrdtMutationCommand,
    CrdtMutationResponseAudience,
    CrdtMutationResult
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { decodeExactDocumentRef } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-exact-document-ref.ts';
import { decodeExactSnapshotEnvelope } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-exact-snapshot-envelope.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    RallarCrdtDocumentLifecycleState,
    RallarCrdtDocumentMetadata,
    RallarCrdtDocumentRef,
    RallarCrdtIntegrityReport,
    RallarCrdtSnapshotEnvelope
} from '@shared/crdt/mod.ts';
import { toRallarCrdtDocumentKey } from '@shared/crdt/mod.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { Either } from '@shared/resilience/Either.ts';

import { hashCanonicalCommand } from '@shared-server/rallar-system/app-inbox/hash-canonical-command.ts';
import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { decodeCrdtAdminLifecycleActions } from './decode-crdt-admin-lifecycle-actions.ts';

export type CrdtAdminMutationOperation =
    | 'rebuild-projection'
    | 'compact'
    | 'lifecycle'
    | 'erase';

export interface CrdtAdminMutationInput {
    readonly operation: CrdtAdminMutationOperation;
    readonly adminSession: AuthSession;
    readonly requestId: string;
    readonly request: JsonWireValue;
}

export type CrdtAdminPublicResult =
    | RallarCrdtIntegrityReport
    | CrdtAdminCompactResult
    | RallarCrdtDocumentMetadata
    | CrdtAdminEraseResult;

export interface CrdtAdminMutations {
    writeCrdtAdminMutation(input: CrdtAdminMutationInput): Promise<CrdtAdminPublicResult>;
}

export interface CrdtAdminMutationInbox {
    writeHttpAdminCommandUntilCompletion(
        reservation: CrdtAdminCommandReservation
    ): Promise<Either<AppInboxFailure, CrdtMutationResult>>;
}

export interface CrdtAdminCommandReservation {
    readonly operation: CrdtAdminMutationOperation;
    readonly requestId: string;
    readonly callerId: string;
    readonly documentKey: string;
    readonly semanticHash: string;
    readonly materialize: () => Promise<CrdtMutationCommand>;
    readonly matches: (command: CrdtMutationCommand) => boolean | Promise<boolean>;
}

export interface CreateCrdtAdminMutationsInput {
    readonly appCrdtInboxService: CrdtAdminMutationInbox;
    readonly nowEpochMs: () => number;
    readonly createId: () => string;
    readonly serviceId: string;
}

interface CreateCrdtAdminCommandInput extends CrdtAdminMutationInput {
    readonly nowEpochMs: () => number;
    readonly createId: () => string;
    readonly serviceId: string;
}

interface CreateCrdtAdminCommandCommon {
    readonly commandId: string;
    readonly deliveryId: string;
    readonly actor: CrdtMutationActor;
    readonly capturedAtEpochMs: number;
    readonly expireAtEpochMs: number;
    readonly document: RallarCrdtDocumentRef;
    readonly responseAudience: CrdtMutationResponseAudience;
}

interface ToCrdtAdminCommandCommonInput {
    readonly mutation: CreateCrdtAdminCommandInput;
    readonly request: JsonWireObject;
    readonly capturedAtEpochMs: number;
}

interface NormalizedCrdtAdminMutation {
    readonly document: RallarCrdtDocumentRef;
    readonly semantic: JsonWireObject;
}

interface CreateCrdtAdminCommandReservationInput {
    readonly mutation: CreateCrdtAdminCommandInput;
    readonly normalized: NormalizedCrdtAdminMutation;
    readonly semanticHash: string;
}

interface MatchStoredCrdtAdminCommandInput {
    readonly command: CrdtMutationCommand;
    readonly semanticHash: string;
}

export function createCrdtAdminMutations(
    input: CreateCrdtAdminMutationsInput
): CrdtAdminMutations {
    return {
        writeCrdtAdminMutation: async (mutation) => {
            const normalized = normalizeCrdtAdminMutation(mutation);
            const semanticHash = await hashCanonicalCommand(normalized.semantic);
            const completed = await input.appCrdtInboxService.writeHttpAdminCommandUntilCompletion(
                createCrdtAdminCommandReservation({
                    mutation: {
                        ...mutation,
                        nowEpochMs: input.nowEpochMs,
                        createId: input.createId,
                        serviceId: input.serviceId
                    },
                    normalized,
                    semanticHash
                })
            );
            if (completed.left !== undefined) {
                throw Object.assign(new Error(completed.left.message), completed.left);
            }
            if (completed.right === undefined) {
                throw new Error('CRDT AppInbox result is missing');
            }
            const result = completed.right;
            if (result.status === 'rejected') {
                throw toAdminMutationError(result.code);
            }
            if (result.operation === 'append') {
                throw new TypeError('CRDT admin mutation returned an append result');
            }
            return toAdminPublicResult(result);
        }
    };
}

function createCrdtAdminCommandReservation(
    input: CreateCrdtAdminCommandReservationInput
): CrdtAdminCommandReservation {
    return {
        operation: input.mutation.operation,
        requestId: input.mutation.requestId,
        callerId: input.mutation.adminSession.clientId,
        documentKey: toRallarCrdtDocumentKey(input.normalized.document),
        semanticHash: input.semanticHash,
        materialize: () => createCrdtAdminCommand(input.mutation),
        matches: (command) =>
            matchesStoredCrdtAdminCommand({
                command,
                semanticHash: input.semanticHash
            })
    };
}

async function matchesStoredCrdtAdminCommand(
    input: MatchStoredCrdtAdminCommandInput
): Promise<boolean> {
    return await hashCanonicalCommand(toCrdtAdminSemanticCommand(input.command)) ===
        input.semanticHash;
}

function normalizeCrdtAdminMutation(
    input: CrdtAdminMutationInput
): NormalizedCrdtAdminMutation {
    const request = requireRecord(input.request);
    if (input.operation === 'lifecycle') {
        requireLifecycle(request.lifecycle);
    }
    const document = decodeExactDocumentRef(request.document, 'CRDT command document');
    const common = {
        version: 1,
        operation: input.operation,
        requestId: input.requestId,
        callerId: input.adminSession.clientId,
        document
    } as const;
    switch (input.operation) {
        case 'rebuild-projection':
            return {
                document,
                semantic: { ...common, projectionId: readString(request.projectionId) ?? 'default' }
            };
        case 'compact':
            return {
                document,
                semantic: {
                    ...common,
                    snapshot: decodeJsonWireValue(
                        readSnapshot(request.snapshot),
                        'CRDT admin compact snapshot'
                    ),
                    reason: readString(request.reason) ?? 'api-v1-admin-compaction'
                }
            };
        case 'lifecycle':
            const lifecycleActions = decodeCrdtAdminLifecycleActions(request);
            return {
                document,
                semantic: {
                    ...common,
                    lifecycle: requireLifecycle(request.lifecycle),
                    ...lifecycleActions
                }
            };
        case 'erase':
            return {
                document,
                semantic: {
                    ...common,
                    mode: request.mode === 'redact-payloads' ? 'redact-payloads' : 'destroy-document',
                    reason: readString(request.reason) ?? 'api-v1-admin-erasure-workflow'
                }
            };
    }
}

function toCrdtAdminSemanticCommand(command: CrdtMutationCommand): JsonWireObject {
    const common = {
        version: 1,
        operation: command.operation,
        requestId: command.deliveryId,
        callerId: command.actor.actorId,
        document: command.document
    } as const;
    switch (command.operation) {
        case 'append':
            throw new TypeError('CRDT HTTP admin reservation contains an append command');
        case 'rebuild-projection':
            return { ...common, projectionId: command.projectionId };
        case 'compact':
            return {
                ...common,
                snapshot: decodeJsonWireValue(
                    command.snapshot,
                    'Stored CRDT admin compact snapshot'
                ),
                reason: command.reason
            };
        case 'lifecycle':
            return {
                ...common,
                lifecycle: command.lifecycle,
                retentionAction: command.retentionAction,
                quotaAction: command.quotaAction,
                projectionIdsAction: command.projectionIdsAction
            };
        case 'erase':
            return { ...common, mode: command.mode, reason: command.reason };
    }
}

async function createCrdtAdminCommand(
    input: CreateCrdtAdminCommandInput
): Promise<CrdtMutationCommand> {
    const request = requireRecord(input.request);
    if (!request.document || typeof request.document !== 'object') {
        throw new TypeError('CRDT document is required');
    }
    const capturedAtEpochMs = input.nowEpochMs();

    switch (input.operation) {
        case 'rebuild-projection': {
            const common = toCrdtAdminCommandCommon({ mutation: input, request, capturedAtEpochMs });
            return await createCrdtMutationCommand({
                ...common,
                operation: input.operation,
                projectionId: readString(request.projectionId) ?? 'default'
            });
        }
        case 'compact': {
            const common = toCrdtAdminCommandCommon({ mutation: input, request, capturedAtEpochMs });
            const snapshotId = readSnapshotId(request.snapshot) ?? input.createId();
            const snapshot = readSnapshot(request.snapshot);
            return await createCrdtMutationCommand({
                ...common,
                operation: input.operation,
                snapshotId,
                snapshot,
                reason: readString(request.reason) ?? 'api-v1-admin-compaction'
            });
        }
        case 'lifecycle': {
            const lifecycle = requireLifecycle(request.lifecycle);
            const lifecycleActions = decodeCrdtAdminLifecycleActions(request);
            const common = toCrdtAdminCommandCommon({ mutation: input, request, capturedAtEpochMs });
            return await createCrdtMutationCommand({
                ...common,
                ...lifecycleActions,
                lifecycle,
                operation: input.operation
            });
        }
        case 'erase': {
            const common = toCrdtAdminCommandCommon({ mutation: input, request, capturedAtEpochMs });
            return await createCrdtMutationCommand({
                ...common,
                operation: input.operation,
                mode: request.mode === 'redact-payloads' ? 'redact-payloads' : 'destroy-document',
                reason: readString(request.reason) ?? 'api-v1-admin-erasure-workflow'
            });
        }
    }
}

function toCrdtAdminCommandCommon(
    input: ToCrdtAdminCommandCommonInput
): CreateCrdtAdminCommandCommon {
    const document = decodeExactDocumentRef(input.request.document, 'CRDT command document');
    return {
        commandId: input.mutation.createId(),
        deliveryId: input.mutation.requestId,
        actor: {
            actorId: input.mutation.adminSession.clientId,
            principalId: input.mutation.adminSession.username,
            sessionId: input.mutation.adminSession.sessionId,
            serverId: input.mutation.serviceId
        },
        capturedAtEpochMs: input.capturedAtEpochMs,
        expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(input.capturedAtEpochMs),
        document,
        responseAudience: {
            kind: 'admin',
            senderSessionId: input.mutation.adminSession.sessionId,
            topicId: 'crdt.admin',
            contextId: toRallarCrdtDocumentKey(document)
        }
    };
}

function toAdminPublicResult(
    result: Exclude<Extract<CrdtMutationResult, { status: 'accepted'; }>, { operation: 'append'; }>
): CrdtAdminPublicResult {
    switch (result.operation) {
        case 'compact':
            return {
                document: result.snapshot.document,
                documentKey: result.documentKey,
                appendSequence: result.appendSequence,
                snapshot: result.snapshot
            };
        case 'lifecycle':
            return result.metadata;
        case 'rebuild-projection':
            return result.integrity;
        case 'erase':
            return {
                request: result.request,
                auditEvent: result.auditEvent,
                ...(result.redactedBundle === null
                    ? { metadata: result.metadata }
                    : { redactedBundle: result.redactedBundle })
            };
    }
}

function requireRecord(value: JsonWireValue): JsonWireObject {
    if (!isRecord(value)) {
        throw new TypeError('CRDT admin request must be an object');
    }
    return value;
}

function isRecord(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: JsonWireValue | undefined): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function readSnapshot(value: JsonWireValue | undefined): RallarCrdtSnapshotEnvelope | null {
    return value === undefined || value === null ? null : decodeExactSnapshotEnvelope(value);
}

function readSnapshotId(value: JsonWireValue | undefined): string | null {
    return value !== null && typeof value === 'object'
        ? readString(Reflect.get(value, 'snapshotId'))
        : null;
}

function toAdminMutationError(code: string | null): Error {
    const status = code?.startsWith('authentication-')
        ? 401
        : code === 'document-not-found'
        ? 404
        : code?.startsWith('authorization-') || code === 'feature-disabled'
        ? 403
        : 409;
    return Object.assign(new Error(`CRDT admin mutation rejected: ${code ?? 'unknown'}`), {
        code: code ?? 'crdt-admin-mutation-rejected',
        status
    });
}

function requireLifecycle(value: JsonWireValue | undefined): RallarCrdtDocumentLifecycleState {
    switch (value) {
        case 'active':
        case 'archived':
        case 'destroyed':
        case 'quarantined':
            return value;
    }
    throw new TypeError('CRDT lifecycle is invalid');
}
