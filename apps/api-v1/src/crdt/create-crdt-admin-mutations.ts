import type { AuthSession } from '@shared/api/api-config.ts';
import type {
  RallarCrdtDocumentLifecycleState,
  RallarCrdtDocumentMetadata,
  RallarCrdtDocumentRef,
  RallarCrdtIntegrityReport,
  RallarCrdtSnapshotEnvelope,
} from '@shared/crdt/mod.ts';
import { toRallarCrdtDocumentKey } from '@shared/crdt/mod.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { Either } from '@shared/resilience/Either.ts';
import type {
  CrdtAdminCompactResult,
  CrdtAdminEraseResult,
  CrdtMutationActor,
  CrdtMutationCommand,
  CrdtMutationResponseAudience,
  CrdtMutationResult,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import {
  createCrdtMutationCommand,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import {
  decodeExactDocumentRef,
  decodeExactProjectionIds,
  decodeExactQuotaPolicy,
  decodeExactRetentionPolicy,
  decodeExactSnapshotEnvelope,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-value-codec.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/services/app-inbox-failure.ts';

import { hashCanonicalCommand } from '@shared-server/rallar-system/services/\
canonical-command-hash.ts';
import type {
  JsonWireObject,
  JsonWireValue,
} from '@shared-server/rallar-system/services/mutation-command-identity.ts';

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
    reservation: Readonly<{
      operation: CrdtAdminMutationOperation;
      requestId: string;
      callerId: string;
      documentKey: string;
      semanticHash: string;
      materialize: () => Promise<CrdtMutationCommand>;
      matches: (command: CrdtMutationCommand) => boolean | Promise<boolean>;
    }>,
  ): Promise<Either<AppInboxFailure, CrdtMutationResult>>;
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

interface ToLifecycleActionInput<T> {
  readonly request: JsonWireObject;
  readonly key: 'retention' | 'quota' | 'projectionIds';
  readonly decode: (value: JsonWireValue) => T;
}

interface NormalizedCrdtAdminMutation {
  readonly document: RallarCrdtDocumentRef;
  readonly semantic: object;
}

export function createCrdtAdminMutations(
  input: CreateCrdtAdminMutationsInput,
): CrdtAdminMutations {
  return {
    writeCrdtAdminMutation: async (mutation) => {
      const normalized = normalizeCrdtAdminMutation(mutation);
      const semanticHash = await hashCanonicalCommand(normalized.semantic);
      const completed = await input.appCrdtInboxService.writeHttpAdminCommandUntilCompletion({
        operation: mutation.operation,
        requestId: mutation.requestId,
        callerId: mutation.adminSession.clientId,
        documentKey: toRallarCrdtDocumentKey(normalized.document),
        semanticHash,
        materialize: async () =>
          await createCrdtAdminCommand({
            ...mutation,
            nowEpochMs: input.nowEpochMs,
            createId: input.createId,
            serviceId: input.serviceId,
          }),
        matches: async (command) =>
          await hashCanonicalCommand(toCrdtAdminSemanticCommand(command)) === semanticHash,
      });
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
    },
  };
}

function normalizeCrdtAdminMutation(
  input: CrdtAdminMutationInput,
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
    document,
  } as const;
  switch (input.operation) {
    case 'rebuild-projection':
      return {
        document,
        semantic: { ...common, projectionId: readString(request.projectionId) ?? 'default' },
      };
    case 'compact':
      return {
        document,
        semantic: {
          ...common,
          snapshot: readSnapshot(request.snapshot),
          reason: readString(request.reason) ?? 'api-v1-admin-compaction',
        },
      };
    case 'lifecycle':
      return {
        document,
        semantic: {
          ...common,
          lifecycle: requireLifecycle(request.lifecycle),
          retentionAction: toLifecycleAction({
            request,
            key: 'retention',
            decode: decodeExactRetentionPolicy,
          }),
          quotaAction: toLifecycleAction({
            request,
            key: 'quota',
            decode: decodeExactQuotaPolicy,
          }),
          projectionIdsAction: toLifecycleAction({
            request,
            key: 'projectionIds',
            decode: decodeExactProjectionIds,
          }),
        },
      };
    case 'erase':
      return {
        document,
        semantic: {
          ...common,
          mode: request.mode === 'redact-payloads' ? 'redact-payloads' : 'destroy-document',
          reason: readString(request.reason) ?? 'api-v1-admin-erasure-workflow',
        },
      };
  }
}

function toCrdtAdminSemanticCommand(command: CrdtMutationCommand): object {
  const common = {
    version: 1,
    operation: command.operation,
    requestId: command.deliveryId,
    callerId: command.actor.actorId,
    document: command.document,
  } as const;
  switch (command.operation) {
    case 'append':
      throw new TypeError('CRDT HTTP admin reservation contains an append command');
    case 'rebuild-projection':
      return { ...common, projectionId: command.projectionId };
    case 'compact':
      return { ...common, snapshot: command.snapshot, reason: command.reason };
    case 'lifecycle':
      return {
        ...common,
        lifecycle: command.lifecycle,
        retentionAction: command.retentionAction,
        quotaAction: command.quotaAction,
        projectionIdsAction: command.projectionIdsAction,
      };
    case 'erase':
      return { ...common, mode: command.mode, reason: command.reason };
  }
}

async function createCrdtAdminCommand(
  input: CreateCrdtAdminCommandInput,
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
        projectionId: readString(request.projectionId) ?? 'default',
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
        reason: readString(request.reason) ?? 'api-v1-admin-compaction',
      });
    }
    case 'lifecycle': {
      const lifecycle = requireLifecycle(request.lifecycle);
      const common = toCrdtAdminCommandCommon({ mutation: input, request, capturedAtEpochMs });
      return await createCrdtMutationCommand({
        ...common,
        operation: input.operation,
        lifecycle,
        retentionAction: toLifecycleAction({
          request,
          key: 'retention',
          decode: decodeExactRetentionPolicy,
        }),
        quotaAction: toLifecycleAction({
          request,
          key: 'quota',
          decode: decodeExactQuotaPolicy,
        }),
        projectionIdsAction: toLifecycleAction({
          request,
          key: 'projectionIds',
          decode: decodeExactProjectionIds,
        }),
      });
    }
    case 'erase': {
      const common = toCrdtAdminCommandCommon({ mutation: input, request, capturedAtEpochMs });
      return await createCrdtMutationCommand({
        ...common,
        operation: input.operation,
        mode: request.mode === 'redact-payloads' ? 'redact-payloads' : 'destroy-document',
        reason: readString(request.reason) ?? 'api-v1-admin-erasure-workflow',
      });
    }
  }
}

function toCrdtAdminCommandCommon(
  input: ToCrdtAdminCommandCommonInput,
): CreateCrdtAdminCommandCommon {
  const document = decodeExactDocumentRef(input.request.document, 'CRDT command document');
  return {
    commandId: input.mutation.createId(),
    deliveryId: input.mutation.requestId,
    actor: {
      actorId: input.mutation.adminSession.clientId,
      principalId: input.mutation.adminSession.username,
      sessionId: input.mutation.adminSession.sessionId,
      serverId: input.mutation.serviceId,
    },
    capturedAtEpochMs: input.capturedAtEpochMs,
    expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(input.capturedAtEpochMs),
    document,
    responseAudience: {
      kind: 'admin',
      senderSessionId: input.mutation.adminSession.sessionId,
      topicId: 'crdt.admin',
      contextId: toRallarCrdtDocumentKey(document),
    },
  };
}

function toAdminPublicResult(
  result: Exclude<
    Extract<CrdtMutationResult, { status: 'accepted' }>,
    { operation: 'append' }
  >,
): CrdtAdminPublicResult {
  switch (result.operation) {
    case 'compact':
      return {
        document: result.snapshot.document,
        documentKey: result.documentKey,
        appendSequence: result.appendSequence,
        snapshot: result.snapshot,
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
          : { redactedBundle: result.redactedBundle }),
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

function toLifecycleAction<T>(
  input: ToLifecycleActionInput<T>,
):
  | Readonly<{ kind: 'preserve' }>
  | Readonly<{ kind: 'clear' }>
  | Readonly<{ kind: 'set'; value: T }> {
  if (!(input.key in input.request)) {
    return { kind: 'preserve' };
  }
  const value = input.request[input.key];
  return value === null ? { kind: 'clear' } : { kind: 'set', value: input.decode(value) };
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
    status,
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
