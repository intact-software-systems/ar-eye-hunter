import type { AuthSession } from '@shared/api/api-config.ts';
import type {
  RallarCrdtDocumentLifecycleState,
  RallarCrdtDocumentRef,
  RallarCrdtQuotaPolicy,
  RallarCrdtRetentionPolicy,
  RallarCrdtSnapshotEnvelope,
} from '@shared/crdt/mod.ts';
import { toRallarCrdtDocumentKey } from '@shared/crdt/mod.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { Either } from '@shared/resilience/Either.ts';
import type {
  CrdtMutationActor,
  CrdtMutationCommand,
  CrdtMutationResponseAudience,
  CrdtMutationResult,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import {
  createCrdtMutationCommand,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import {
  decodeCrdtMutationResult,
} from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';
import {
  decodeExactDocumentRef,
  decodeExactProjectionIds,
  decodeExactQuotaPolicy,
  decodeExactRetentionPolicy,
  decodeExactSnapshotEnvelope,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-value-codec.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/services/app-inbox-failure.ts';

export type CrdtAdminMutationOperation =
  | 'rebuild-projection'
  | 'compact'
  | 'lifecycle'
  | 'erase';

export interface CrdtAdminMutationInput {
  readonly operation: CrdtAdminMutationOperation;
  readonly adminSession: AuthSession;
  readonly request: unknown;
}

export interface CrdtAdminMutations {
  writeCrdtAdminMutation(input: CrdtAdminMutationInput): Promise<unknown>;
}

export interface CrdtAdminMutationInbox {
  writeCrdtCommandUntilCompletion(
    command: CrdtMutationCommand,
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
  readonly actor: CrdtMutationActor;
  readonly capturedAtEpochMs: number;
  readonly expireAtEpochMs: number;
  readonly document: RallarCrdtDocumentRef;
  readonly responseAudience: CrdtMutationResponseAudience;
}

interface ToCrdtAdminCommandCommonInput {
  readonly mutation: CreateCrdtAdminCommandInput;
  readonly request: Record<string, unknown>;
  readonly capturedAtEpochMs: number;
}

interface ToLifecycleActionInput<T> {
  readonly request: Record<string, unknown>;
  readonly key: 'retention' | 'quota' | 'projectionIds';
  readonly decode: (value: unknown) => T;
}

export function createCrdtAdminMutations(
  input: CreateCrdtAdminMutationsInput,
): CrdtAdminMutations {
  return {
    writeCrdtAdminMutation: async (mutation) => {
      const command = await createCrdtAdminCommand({
        ...mutation,
        nowEpochMs: input.nowEpochMs,
        createId: input.createId,
        serviceId: input.serviceId,
      });
      const completed = await input.appCrdtInboxService.writeCrdtCommandUntilCompletion(command);
      if (completed.left !== undefined) {
        throw Object.assign(new Error(completed.left.message), completed.left);
      }
      if (completed.right === undefined) {
        throw new Error('CRDT AppInbox result is missing');
      }
      const result = decodeCrdtMutationResult(completed.right);
      if (result.status === 'rejected') {
        throw toAdminMutationError(result.code);
      }
      return toAdminPublicResult(result);
    },
  };
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
    commandId: readString(input.request.requestId) ?? input.mutation.createId(),
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

function toAdminPublicResult(result: CrdtMutationResult): unknown {
  switch (result.operation) {
    case 'compact':
      return {
        document: result.snapshot?.document ?? null,
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
    case 'append':
      return result;
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('CRDT admin request must be an object');
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readSnapshot(value: unknown): RallarCrdtSnapshotEnvelope | null {
  return value === undefined || value === null ? null : decodeExactSnapshotEnvelope(value);
}

function readSnapshotId(value: unknown): string | null {
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

function requireLifecycle(value: unknown): RallarCrdtDocumentLifecycleState {
  if (!['active', 'archived', 'destroyed', 'quarantined'].includes(String(value))) {
    throw new TypeError('CRDT lifecycle is invalid');
  }
  return value as RallarCrdtDocumentLifecycleState;
}
