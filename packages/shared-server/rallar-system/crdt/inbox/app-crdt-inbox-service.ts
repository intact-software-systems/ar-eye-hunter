import type { RallarCrdtAuditSink, RallarCrdtUpdateEnvelope } from '@shared/crdt/mod.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';

import type { PSqlSql } from '../../../postgres/PostgresSqlClient.ts';
// prettier-ignore
import type { ResourceInboxRepository } from '../../../postgres/resource-inbox/\
ResourceInboxRepository.ts';
// prettier-ignore
import type { ResourceInboxResultsRepository } from '../../../postgres/resource-inbox/\
ResourceInboxResultsRepository.ts';
import type { AppInboxFailure } from '../../services/app-inbox-failure.ts';
import { toAppQueueKey } from '../../services/app-inbox-queue-key.ts';
import { type AppInboxMessageContext, AppInboxType } from '../../services/app-inbox-contracts.ts';
import { AppInboxService, type AppInboxServiceOptions } from '../../services/AppInboxService.ts';
import type { RallarTimingSink } from '../../services/timing.ts';
import {
  CRDT_MUTATION_INBOX_TYPES,
  type CrdtAppendCommand,
  type CrdtMutationActor,
  type CrdtMutationCommand,
  type CrdtMutationResponseAudience,
  type CrdtMutationResult,
} from '../mutation/crdt-mutation-contracts.ts';
import {
  createCrdtMutationCommand,
  decodeCrdtMutationCommand,
} from '../mutation/crdt-mutation-command-codec.ts';
import type { CrdtMutationService } from '../mutation/create-crdt-mutation-service.ts';
import {
  type AuthenticatedCrdtAppendInput,
  createAndEnqueueAuthenticatedCrdtAppend,
  type ReadCurrentCrdtMutationSession,
} from './create-authenticated-crdt-append.ts';
import { registerCrdtAuditDelivery } from './register-crdt-audit-delivery.ts';

export const CRDT_APP_INBOX_TOPIC = 'app-inbox.crdt-state';

export interface CreateAndEnqueueCrdtAppendInput {
  readonly update: RallarCrdtUpdateEnvelope;
  readonly deliveryId: string;
  readonly actor: CrdtMutationActor;
  readonly responseAudience: CrdtMutationResponseAudience;
  readonly capturedAtEpochMs: number;
  readonly expireAtEpochMs: number;
}

export namespace AppCrdtInboxService {
  export interface AuditDelivery {
    readonly outboxQueueReader: OutboxQueueReader;
    readonly auditSink: RallarCrdtAuditSink;
  }

  export interface Dependencies {
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly resourceInboxRepository: ResourceInboxRepository;
    readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
    readonly database: PSqlSql;
    readonly mutationService: CrdtMutationService;
    readonly readCurrentSession: ReadCurrentCrdtMutationSession;
    readonly wakeQueueEngine: () => void;
    readonly auditDelivery?: AuditDelivery;
  }

  export interface Config {
    readonly serviceId: string;
    readonly timing: RallarTimingSink | undefined;
    readonly appInbox: AppInboxServiceOptions;
  }
}

export class AppCrdtInboxService extends AppInboxService {
  private readonly readCurrentSession: ReadCurrentCrdtMutationSession;
  private readonly wakeQueueEngine: () => void;

  public readonly mutationService: CrdtMutationService;

  constructor(dependencies: AppCrdtInboxService.Dependencies, config: AppCrdtInboxService.Config) {
    super(
      dependencies.inboxQueueReader,
      dependencies.resourceInboxRepository,
      dependencies.resourceInboxResultsRepository,
      dependencies.database,
      config.serviceId,
      CRDT_APP_INBOX_TOPIC,
      config.timing,
      config.appInbox,
      dependencies.wakeQueueEngine,
    );
    this.mutationService = dependencies.mutationService;
    this.readCurrentSession = dependencies.readCurrentSession;
    this.wakeQueueEngine = dependencies.wakeQueueEngine;
    if (dependencies.auditDelivery !== undefined) {
      registerCrdtAuditDelivery(dependencies.auditDelivery);
    }
    for (const type of CRDT_MUTATION_INBOX_TYPES) {
      this.onStateMessage<unknown>(
        type,
        async (value, appInboxContext) => await this.processCommand(value, appInboxContext),
      );
    }
  }

  async writeCrdtCommandUntilCompletion(
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

  writeCrdtCommandNoWaiting(command: CrdtMutationCommand): void {
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

  async createAndEnqueueAppend(input: CreateAndEnqueueCrdtAppendInput): Promise<CrdtAppendCommand> {
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
    if (command.operation !== 'append') {
      throw new TypeError('CRDT append command is invalid');
    }
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
      readCurrentSession: this.readCurrentSession,
      enqueue: async (append) => await this.createAndEnqueueAppend(append),
    });
  }

  private async processCommand(
    value: unknown,
    appInboxContext: AppInboxMessageContext,
  ): Promise<CrdtMutationResult> {
    const command = decodeCrdtMutationCommand(value);
    assertCrdtAppInboxIdentity({ command, appInboxContext });

    const read = await this.mutationService.read(command);
    const computed = this.mutationService.compute({ command, read });
    const issues = this.mutationService.validate({ command, read, computed });
    if (issues[0] !== undefined) {
      throw new TypeError(issues[0].message);
    }
    const result = await this.writeMutation(
      appInboxContext,
      async (transaction) => await this.mutationService.write(transaction, computed),
    );
    if (result.operation === 'erase' && result.status === 'accepted') {
      this.wakeQueueEngine();
    }
    return result;
  }
}

interface AssertCrdtAppInboxIdentityInput {
  readonly command: CrdtMutationCommand;
  readonly appInboxContext: AppInboxMessageContext;
}

function assertCrdtAppInboxIdentity(input: AssertCrdtAppInboxIdentityInput): void {
  const expectedKey = toAppQueueKey({
    topicId: CRDT_APP_INBOX_TOPIC,
    resourceId: input.command.deliveryId,
    contextId: input.command.documentKey,
  });
  if (
    toCrdtAppInboxType(input.command) !== input.appInboxContext.enqueue.type ||
    expectedKey.resourceId !== input.appInboxContext.entry.key.resourceId ||
    expectedKey.contextId !== input.appInboxContext.entry.key.contextId
  ) {
    throw new TypeError('CRDT AppInbox command identity differs from queue key');
  }
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
