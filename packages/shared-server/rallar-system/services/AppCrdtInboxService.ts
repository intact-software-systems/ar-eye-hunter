import type { AuthSession } from '@shared/api/api-config.ts';
import {
  type RallarCrdtAuditSink,
  type RallarCrdtDocumentLifecycleState,
  type RallarCrdtDocumentRef,
  type RallarCrdtQuotaPolicy,
  type RallarCrdtRetentionPolicy,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtUpdateEnvelope,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { PSqlSql } from '../../postgres/PostgresSqlClient.ts';
import type { ResourceInboxRepository } from '../../postgres/resource-inbox/ResourceInboxRepository.ts';
import type { ResourceInboxResultsRepository } from '../../postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { toAppQueueKey } from './app-inbox-queue-key.ts';
import type { AppInboxFailure } from './app-inbox-failure.ts';
import { AppInboxService, type AppInboxServiceOptions } from './AppInboxService.ts';
import { type AppInboxMessageContext, AppInboxType } from './app-inbox-contracts.ts';
import {
  CRDT_MUTATION_INBOX_TYPES,
  type CrdtAppendCommand,
  type CrdtMutationActor,
  type CrdtMutationCommand,
  type CrdtMutationResponseAudience,
  type CrdtMutationResult,
} from '../crdt/mutation/crdt-mutation-contracts.ts';
import {
  createCrdtMutationCommand,
  decodeCrdtMutationCommand,
} from '../crdt/mutation/crdt-mutation-command-codec.ts';
import { decodeCrdtMutationResult } from '../crdt/mutation/decode-crdt-mutation-result.ts';
import { decodeCrdtAuditEvent } from '../crdt/mutation/crdt-mutation-value-codec.ts';
import type { CrdtMutationService } from './crdt-mutations.ts';
import type { RallarTimingSink } from './timing.ts';
import { CRDT_AUDIT_APP_OUTBOX_TYPE } from './crdt-mutation-outbox.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import {
  type AuthenticatedCrdtAppendInput,
  createAndEnqueueAuthenticatedCrdtAppend,
  type ResolveCurrentCrdtMutationSession,
} from './crdt-authenticated-append.ts';

export const CRDT_APP_INBOX_TOPIC = 'app-inbox.crdt-state';

export type CrdtAdminMutationOperation = 'rebuild-projection' | 'compact' | 'lifecycle' | 'erase';

export interface AppCrdtInboxServiceInput {
  readonly inbox: InboxQueueReader;
  readonly resourceInbox: ResourceInboxRepository;
  readonly resourceInboxResults: ResourceInboxResultsRepository;
  readonly database: PSqlSql;
  readonly mutationService: CrdtMutationService;
  readonly serviceId: string;
  readonly timing?: RallarTimingSink;
  readonly options?: AppInboxServiceOptions;
  readonly effects?: Readonly<{
    audit?: RallarCrdtAuditSink;
    outboxQueueReader?: OutboxQueueReader;
    wakeQueueEngine?: () => void;
    resolveCurrentSession?: ResolveCurrentCrdtMutationSession;
  }>;
}

export class AppCrdtInboxService extends AppInboxService {
  private audit: RallarCrdtAuditSink | undefined;
  private readonly wakeQueueEngine: (() => void) | undefined;
  private readonly resolveCurrentSession: ResolveCurrentCrdtMutationSession | undefined;

  public readonly mutationService: CrdtMutationService;

  constructor(input: AppCrdtInboxServiceInput) {
    const {
      inbox,
      resourceInbox,
      resourceInboxResults,
      database,
      mutationService,
      serviceId,
      timing,
      options,
    } = input;
    const effects = input.effects ?? {};
    super(
      inbox,
      resourceInbox,
      resourceInboxResults,
      database,
      serviceId,
      CRDT_APP_INBOX_TOPIC,
      timing,
      options,
      effects.wakeQueueEngine,
    );
    this.mutationService = mutationService;
    this.audit = effects.audit;
    this.wakeQueueEngine = effects.wakeQueueEngine;
    this.resolveCurrentSession = effects.resolveCurrentSession;
    effects.outboxQueueReader?.onOutboxMessageDo(CRDT_AUDIT_APP_OUTBOX_TYPE, {
      onMessage: async (message) => {
        if (message.payload.contentType !== 'application/json') {
          throw new TypeError('CRDT audit outbox content type is invalid');
        }
        const event = decodeCrdtAuditEvent(JSON.parse(message.payload.resource));
        if (!this.audit) throw new Error('CRDT audit sink is unavailable');
        await this.audit.record(event);
      },
    });
    for (const type of CRDT_MUTATION_INBOX_TYPES) {
      this.onStateMessage<unknown>(
        type,
        async (data, context) => await this.processCommand(data, context),
      );
    }
  }

  setAuditSink(audit: RallarCrdtAuditSink | undefined): void {
    this.audit = audit;
  }

  async processCrdtCommandUntilCompletion(
    command: CrdtMutationCommand,
  ): Promise<Either<AppInboxFailure, CrdtMutationResult>> {
    const decoded = decodeCrdtMutationCommand(command);
    return await this.processEntryUntilCompletionResult({
      type: toCrdtAppInboxType(decoded),
      topicId: CRDT_APP_INBOX_TOPIC,
      resourceId: decoded.deliveryId,
      contextId: decoded.documentKey,
      senderId: decoded.actor.sessionId,
      data: decoded,
    });
  }

  processCrdtCommandNoWaiting(command: CrdtMutationCommand): void {
    const decoded = decodeCrdtMutationCommand(command);
    this.processEntryNoWaiting({
      type: toCrdtAppInboxType(decoded),
      topicId: CRDT_APP_INBOX_TOPIC,
      resourceId: decoded.deliveryId,
      contextId: decoded.documentKey,
      senderId: decoded.actor.sessionId,
      data: decoded,
    });
  }

  async createAndEnqueueAppend(
    input: Readonly<{
      update: RallarCrdtUpdateEnvelope;
      deliveryId: string;
      actor: CrdtMutationActor;
      responseAudience: CrdtMutationResponseAudience;
      capturedAtEpochMs: number;
      expireAtEpochMs: number;
    }>,
  ): Promise<CrdtAppendCommand> {
    const command = await createCrdtMutationCommand({
      operation: 'append',
      commandId: input.update.updateId,
      deliveryId: input.deliveryId,
      actor: input.actor,
      capturedAtEpochMs: input.capturedAtEpochMs,
      expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(
        input.capturedAtEpochMs,
        input.expireAtEpochMs,
      ),
      document: input.update.document,
      responseAudience: input.responseAudience,
      update: input.update,
      authorizationScope: input.update.document.scope,
    });
    if (command.operation !== 'append') throw new TypeError('CRDT append command is invalid');
    await this.enqueue({
      type: toCrdtAppInboxType(command),
      topicId: CRDT_APP_INBOX_TOPIC,
      resourceId: command.deliveryId,
      contextId: command.documentKey,
      senderId: command.actor.sessionId,
      data: command,
    });
    return command;
  }

  async createAndEnqueueAuthenticatedAppend(
    input: AuthenticatedCrdtAppendInput,
  ): Promise<CrdtAppendCommand> {
    return await createAndEnqueueAuthenticatedCrdtAppend(input, {
      serviceId: this.serviceId,
      resolveCurrentSession: this.resolveCurrentSession,
      enqueue: async (append) => await this.createAndEnqueueAppend(append),
    });
  }

  async processAdminMutationUntilCompletion(
    operation: CrdtAdminMutationOperation,
    input: Readonly<{ adminSession: AuthSession; request: unknown }>,
  ): Promise<unknown> {
    const command = await this.createAdminCommand(operation, input);
    const completed = await this.processCrdtCommandUntilCompletion(command);
    if (completed.left !== undefined) {
      throw Object.assign(new Error(completed.left.message), completed.left);
    }
    if (completed.right === undefined) throw new Error('CRDT AppInbox result is missing');
    const result = decodeCrdtMutationResult(completed.right);
    if (result.status === 'rejected') throw toAdminMutationError(result.code);
    return toAdminPublicResult(result);
  }

  private async processCommand(
    input: unknown,
    context: AppInboxMessageContext,
  ): Promise<CrdtMutationResult> {
    const command = decodeCrdtMutationCommand(input);
    const expectedKey = toAppQueueKey({
      topicId: CRDT_APP_INBOX_TOPIC,
      resourceId: command.deliveryId,
      contextId: command.documentKey,
    });
    if (
      toCrdtAppInboxType(command) !== context.enqueue.type ||
      expectedKey.resourceId !== context.entry.key.resourceId ||
      expectedKey.contextId !== context.entry.key.contextId
    )
      throw new TypeError('CRDT AppInbox command identity differs from queue key');
    const read = await this.mutationService.read(command);
    const computed = this.mutationService.compute(command, read);
    this.mutationService.validate(command, read, computed);
    const result = await this.writeMutation(
      context,
      async (transaction) => await this.mutationService.write(transaction, computed),
    );
    if (result.operation === 'erase' && result.status === 'accepted') {
      this.wakeQueueEngine?.();
    }
    return result;
  }

  private async createAdminCommand(
    operation: CrdtAdminMutationOperation,
    input: Readonly<{ adminSession: AuthSession; request: unknown }>,
  ): Promise<CrdtMutationCommand> {
    const request = requireRecord(input.request);
    const document = requireDocument(request.document);
    const capturedAtEpochMs = this.nowEpochMs();
    const common = {
      commandId: readString(request.requestId) ?? crypto.randomUUID(),
      actor: {
        actorId: input.adminSession.clientId,
        principalId: input.adminSession.username,
        sessionId: input.adminSession.sessionId,
        serverId: this.serviceId,
      },
      capturedAtEpochMs,
      expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(capturedAtEpochMs),
      document,
      responseAudience: {
        kind: 'admin' as const,
        senderSessionId: input.adminSession.sessionId,
        topicId: 'crdt.admin',
        contextId: toRallarCrdtDocumentKey(document),
      },
    };
    if (operation === 'rebuild-projection') {
      return await createCrdtMutationCommand({
        ...common,
        operation,
        projectionId: readString(request.projectionId) ?? 'default',
      });
    }
    if (operation === 'compact') {
      const snapshot =
        request.snapshot === undefined ? null : (request.snapshot as RallarCrdtSnapshotEnvelope);
      return await createCrdtMutationCommand({
        ...common,
        operation,
        snapshotId: snapshot?.snapshotId ?? crypto.randomUUID(),
        snapshot,
        reason: readString(request.reason) ?? 'api-v1-admin-compaction',
      });
    }
    if (operation === 'lifecycle') {
      return await createCrdtMutationCommand({
        ...common,
        operation,
        lifecycle: requireLifecycle(request.lifecycle),
        retentionAction: toLifecycleAction<RallarCrdtRetentionPolicy>(request, 'retention'),
        quotaAction: toLifecycleAction<RallarCrdtQuotaPolicy>(request, 'quota'),
        projectionIdsAction: toLifecycleAction<readonly string[]>(request, 'projectionIds'),
      });
    }
    return await createCrdtMutationCommand({
      ...common,
      operation,
      mode: request.mode === 'redact-payloads' ? 'redact-payloads' : 'destroy-document',
      reason: readString(request.reason) ?? 'api-v1-admin-erasure-workflow',
    });
  }
}

function toAdminPublicResult(result: CrdtMutationResult): unknown {
  if (result.operation === 'compact') {
    return {
      document: result.snapshot?.document ?? null,
      documentKey: result.documentKey,
      appendSequence: result.appendSequence,
      snapshot: result.snapshot,
    };
  }
  if (result.operation === 'lifecycle') return result.metadata;
  if (result.operation === 'rebuild-projection') return result.integrity;
  if (result.operation === 'erase') {
    return {
      request: result.request,
      auditEvent: result.auditEvent,
      ...(result.redactedBundle === null
        ? { metadata: result.metadata }
        : { redactedBundle: result.redactedBundle }),
    };
  }
  return result;
}

export function toCrdtAppInboxType(command: CrdtMutationCommand): AppInboxType {
  switch (command.operation) {
    case 'append':
      return AppInboxType.CRDT_UPDATE_APPEND;
    case 'rebuild-projection':
      return AppInboxType.CRDT_PROJECTION_REBUILD;
    case 'compact':
      return AppInboxType.CRDT_SNAPSHOT_COMPACT;
    case 'lifecycle':
      return AppInboxType.CRDT_LIFECYCLE_UPDATE;
    case 'erase':
      return AppInboxType.CRDT_ERASE;
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('CRDT admin request must be an object');
  }
  return value as Record<string, unknown>;
}

function requireDocument(value: unknown): RallarCrdtDocumentRef {
  if (!value || typeof value !== 'object') throw new TypeError('CRDT document is required');
  toRallarCrdtDocumentKey(value as RallarCrdtDocumentRef);
  return value as RallarCrdtDocumentRef;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toLifecycleAction<T>(request: Record<string, unknown>, key: string) {
  if (!(key in request)) return { kind: 'preserve' as const };
  if (request[key] === null) return { kind: 'clear' as const };
  if (
    key === 'projectionIds' &&
    (!Array.isArray(request[key]) || request[key].some((entry) => typeof entry !== 'string'))
  ) {
    throw new TypeError('CRDT projectionIds are invalid');
  }
  if (
    key !== 'projectionIds' &&
    (!request[key] || typeof request[key] !== 'object' || Array.isArray(request[key]))
  ) {
    throw new TypeError(`CRDT ${key} is invalid`);
  }
  return { kind: 'set' as const, value: request[key] as T };
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
