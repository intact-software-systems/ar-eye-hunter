import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import type { AppInboxMessageContext } from '../../services/app-inbox-contracts.ts';
// prettier-ignore
import type {
  AppInboxMutationTransactionWriter,
} from '../../services/app-inbox-transaction-writer.ts';
import {
  type WsSessionGenerationFacts,
  type WsSessionGenerationLifecycleComputed,
  type WsSessionGenerationLifecycleService,
} from '../../services/ws-session-generation-lifecycle.ts';
import {
  toClientMutationCommand,
  toConnectCommandInput,
  toDisconnectCommandInput,
  toExpiryCommandInput,
  type ClientMutationPersistedFacts,
} from '../mutation/client-mutation-command.ts';
import type {
  ClientMutationCommand,
  ClientMutationCommandInput,
  ClientMutationComputed,
} from '../mutation/client-mutation-contracts.ts';
// prettier-ignore
import {
  validateClientMutationAuthorityPolicy,
} from '../mutation/result-validation/validate-client-mutation-authority-policy.ts';
import {
  type ClientStateMutationService,
  type ClientStateService,
  type ClientStateWritten,
  requiresClientWrite,
  toClientStateWritten,
} from '../client-state-service-contracts.ts';
import { readClientMutationAuthority } from './authenticated-client-mutation-ingress.ts';
import type {
  ClientAuthorisedWsSessionConnectAppInboxPayload,
  ClientAuthorisedWsSessionDisconnectAppInboxPayload,
} from './app-client-inbox-contracts.ts';

export interface ClientStateInboxHandlerDependencies {
  readonly mutationService: ClientStateMutationService;
  readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
  readonly expiryCandidates: Pick<ClientStateService, 'listExpiredSessionCandidates'>;
  readonly snapshotObserver: Pick<ClientStateService, 'observeSnapshot'>;
  readonly transactionWriter: AppInboxMutationTransactionWriter;
  readonly serviceId: string;
}

export interface ClientStateInboxAfterCommitResult {
  readonly committedSnapshots: readonly import('@shared/api/client-types.ts').ClientSnapshot[];
}

interface InactiveAuthorisedWsSession {
  readonly status: 'inactive';
  readonly sessionId: string;
  readonly generationId: string;
}

type AuthorisedWsClientMutationResult = ClientStateWritten | InactiveAuthorisedWsSession;

export class ClientStateInboxHandler {
  constructor(private readonly dependencies: ClientStateInboxHandlerDependencies) {}

  async processCommand(
    context: AppInboxMessageContext,
    input: ClientMutationCommandInput,
  ): Promise<ClientStateWritten> {
    const command = await this.toCommand(context, input);
    const read = await this.dependencies.mutationService.read(command);
    const computed = this.dependencies.mutationService.compute(command, read);
    this.dependencies.mutationService.validate(command, read, computed);
    return await this.commitComputed(context, computed);
  }

  async processAuthorisedWsConnect(
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload,
    context: AppInboxMessageContext,
  ): Promise<AuthorisedWsClientMutationResult> {
    const lifecycleFacts = toWsSessionGenerationFacts(connection);
    const lifecycleRead = await this.dependencies.sessionGenerationLifecycle.read(lifecycleFacts);
    if (
      this.dependencies.sessionGenerationLifecycle.isGenerationClosed(lifecycleFacts, lifecycleRead)
    ) {
      return await this.writeInactiveGeneration(context, connection);
    }
    const command = await this.toAuthorisedWsConnectCommand(context, connection);
    const computed = await this.computeValidatedMutation(command);
    const lifecycleComputed = this.dependencies.sessionGenerationLifecycle.computeConnectGuard(
      {
        ...lifecycleFacts,
        expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(
          connection.generationStartedAtEpochMs,
          connection.expiresAtEpochMs,
        ),
      },
      lifecycleRead,
    );
    return await this.commitComputed(context, computed, lifecycleComputed);
  }

  async processAuthorisedWsDisconnect(
    input: ClientAuthorisedWsSessionDisconnectAppInboxPayload,
    context: AppInboxMessageContext,
  ): Promise<AuthorisedWsClientMutationResult> {
    const lifecycleComputed = await this.computeAuthorisedWsDisconnectLifecycle(input);
    const command = await this.toAuthorisedWsDisconnectCommand(context, input);
    const read = await this.dependencies.mutationService.read(command);
    if (!read.session) {
      return await this.writeMissingSessionDisconnect(
        context,
        input,
        command,
        read,
        lifecycleComputed,
      );
    }
    const computed = this.dependencies.mutationService.compute(command, read);
    this.dependencies.mutationService.validate(command, read, computed);
    return await this.commitComputed(context, computed, lifecycleComputed);
  }

  async processExpiredSessionCommands(
    context: AppInboxMessageContext,
    atEpochMs: number,
  ): Promise<readonly ClientStateWritten[]> {
    const computed = await this.computeExpiredSessionMutations(context, atEpochMs);
    const applied = computed.filter((successor) => successor.outcome === 'write');
    const durableResult = applied.map(toClientStateWritten);
    const result = await this.dependencies.transactionWriter.writeMutationWithAfterCommitResult(
      context,
      async (transaction) => {
        for (const successor of computed) {
          if (requiresClientWrite(successor)) {
            await this.dependencies.mutationService.write(transaction, successor);
          }
        }
        return {
          durableResult,
          afterCommitResult: { committedSnapshots: applied.map((successor) => successor.snapshot) },
        };
      },
    );
    await this.observeCommittedSnapshots(result.afterCommitResult);
    return result.durableResult;
  }

  private async computeValidatedMutation(
    command: ClientMutationCommand,
  ): Promise<ClientMutationComputed> {
    const read = await this.dependencies.mutationService.read(command);
    const computed = this.dependencies.mutationService.compute(command, read);
    this.dependencies.mutationService.validate(command, read, computed);
    return computed;
  }

  private async commitComputed(
    context: AppInboxMessageContext,
    computed: ClientMutationComputed,
    lifecycleComputed?: WsSessionGenerationLifecycleComputed,
  ): Promise<ClientStateWritten> {
    if (computed.outcome === 'idempotency-conflict') {
      throw new Error('Validated client idempotency conflict is unreachable');
    }
    const durableResult = toClientStateWritten(computed);
    const result = await this.dependencies.transactionWriter.writeMutationWithAfterCommitResult(
      context,
      async (transaction) => {
        await this.writeComputedMutation(transaction, computed, lifecycleComputed);
        return {
          durableResult,
          afterCommitResult: { committedSnapshots: [computed.snapshot] },
        };
      },
    );
    await this.observeCommittedSnapshots(result.afterCommitResult);
    return result.durableResult;
  }

  private async writeComputedMutation(
    transaction: PSqlTransactionSql,
    computed: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict' }>,
    lifecycleComputed: WsSessionGenerationLifecycleComputed | undefined,
  ): Promise<void> {
    if (lifecycleComputed) {
      await this.dependencies.sessionGenerationLifecycle.write(transaction, lifecycleComputed);
    }
    if (requiresClientWrite(computed)) {
      await this.dependencies.mutationService.write(transaction, computed);
    }
  }

  private async observeCommittedSnapshots(
    result: ClientStateInboxAfterCommitResult,
  ): Promise<void> {
    for (const snapshot of result.committedSnapshots) {
      await this.dependencies.snapshotObserver.observeSnapshot(snapshot);
    }
  }

  private async toCommand(
    context: AppInboxMessageContext,
    input: ClientMutationCommandInput,
  ): Promise<ClientMutationCommand> {
    return await toClientMutationCommand(
      input,
      toClientMutationPersistedFacts(context, input.commandId, this.dependencies.serviceId),
      readClientMutationAuthority(context.enqueue.authority, input.operation),
    );
  }

  private async writeInactiveGeneration(
    context: AppInboxMessageContext,
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload,
  ): Promise<InactiveAuthorisedWsSession> {
    return await this.dependencies.transactionWriter.writeMutation(context, async () => ({
      status: 'inactive',
      sessionId: connection.authSession.sessionId,
      generationId: connection.generationId,
    }));
  }

  private async computeAuthorisedWsDisconnectLifecycle(
    input: ClientAuthorisedWsSessionDisconnectAppInboxPayload,
  ): Promise<WsSessionGenerationLifecycleComputed> {
    const connection = input.connection;
    const lifecycleFacts = {
      ...toWsSessionGenerationFacts(connection),
      disconnectedAtEpochMs: input.disconnectedAtEpochMs,
      reason: input.reason,
      expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(
        input.disconnectedAtEpochMs,
        Math.max(input.disconnectedAtEpochMs, connection.expiresAtEpochMs),
      ),
    };
    return this.dependencies.sessionGenerationLifecycle.computeClosed(
      lifecycleFacts,
      await this.dependencies.sessionGenerationLifecycle.read(lifecycleFacts),
    );
  }

  private async writeMissingSessionDisconnect(
    context: AppInboxMessageContext,
    input: ClientAuthorisedWsSessionDisconnectAppInboxPayload,
    command: ClientMutationCommand,
    read: Awaited<ReturnType<ClientStateMutationService['read']>>,
    lifecycleComputed: WsSessionGenerationLifecycleComputed,
  ): Promise<InactiveAuthorisedWsSession> {
    validateClientMutationAuthorityPolicy(command, read);
    return await this.dependencies.transactionWriter.writeMutation(context, async (transaction) => {
      await this.dependencies.sessionGenerationLifecycle.write(transaction, lifecycleComputed);
      return {
        status: 'inactive',
        sessionId: input.connection.authSession.sessionId,
        generationId: input.connection.generationId,
      };
    });
  }

  private async toAuthorisedWsConnectCommand(
    context: AppInboxMessageContext,
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload,
  ): Promise<ClientMutationCommand> {
    const requestId = toAuthorisedWsRequestId('connect', connection);
    return await this.toCommand(
      context,
      toConnectCommandInput(
        'connectAuthorisedWsSession',
        connection.scope,
        connection.principalId,
        connection.clientInstanceId,
        connection.authSession.sessionId,
        {
          generationId: connection.generationId,
          presenceState: 'online',
          transport: 'ws',
          connectionId: connection.generationId,
          connectedAtEpochMs: connection.generationStartedAtEpochMs,
          expiresAtEpochMs: connection.expiresAtEpochMs,
          actorPrincipalId: connection.principalId,
          actorSessionId: connection.authSession.sessionId,
          requestId,
        },
        requestId,
        {
          platform: connection.platform,
          userAgent: connection.userAgent ?? undefined,
          capabilities: connection.capabilities,
          principalUsername: connection.authSession.username,
          principalDisplayName: connection.displayName,
          principalRoles: ['member'],
        },
      ),
    );
  }

  private async toAuthorisedWsDisconnectCommand(
    context: AppInboxMessageContext,
    input: ClientAuthorisedWsSessionDisconnectAppInboxPayload,
  ): Promise<ClientMutationCommand> {
    const connection = input.connection;
    return await this.toCommand(
      context,
      toDisconnectCommandInput(
        'disconnectAuthorisedWsSession',
        connection.scope,
        connection.principalId,
        connection.clientInstanceId,
        connection.authSession.sessionId,
        {
          generationId: connection.generationId,
          disconnectedAtEpochMs: input.disconnectedAtEpochMs,
          reason: input.reason,
          actorPrincipalId: connection.principalId,
          actorSessionId: connection.authSession.sessionId,
          requestId: toAuthorisedWsRequestId('disconnect', connection),
        },
        context.entry.key.resourceId,
      ),
    );
  }

  private async computeExpiredSessionMutations(
    context: AppInboxMessageContext,
    atEpochMs: number,
  ): Promise<readonly ClientMutationComputed[]> {
    const computed: ClientMutationComputed[] = [];
    for (const candidate of await this.dependencies.expiryCandidates.listExpiredSessionCandidates(
      atEpochMs,
    )) {
      const command = await this.toCommand(context, toExpiryCommandInput(candidate));
      computed.push(await this.computeValidatedMutation(command));
    }
    return computed;
  }
}

function toClientMutationPersistedFacts(
  context: AppInboxMessageContext,
  commandId: string,
  serviceId: string,
): Omit<ClientMutationPersistedFacts, 'commandHash'> {
  return {
    nowEpochMs: context.message.id.ts,
    serviceId,
    eventId: `client-event:${JSON.stringify([
      context.entry.key.contextId,
      context.entry.key.topicId,
      commandId,
    ])}`,
    attemptCount: context.entry.dequeueAudit.attempts,
    expireAtEpochMs: Number(context.entry.audit.expiryTs.epochMilliseconds),
  };
}

function toWsSessionGenerationFacts(
  connection: ClientAuthorisedWsSessionConnectAppInboxPayload,
): WsSessionGenerationFacts {
  return {
    scope: {
      kind: 'client' as const,
      ...connection.scope,
      principalId: connection.principalId,
      clientInstanceId: connection.clientInstanceId,
    },
    sessionId: connection.authSession.sessionId,
    generationId: connection.generationId,
    generationStartedAtEpochMs: connection.generationStartedAtEpochMs,
  };
}

function toAuthorisedWsRequestId(
  operation: 'connect' | 'disconnect',
  connection: ClientAuthorisedWsSessionConnectAppInboxPayload,
): string {
  return [
    'authorised-ws',
    operation,
    connection.authSession.sessionId,
    connection.generationId,
  ].join(':');
}
