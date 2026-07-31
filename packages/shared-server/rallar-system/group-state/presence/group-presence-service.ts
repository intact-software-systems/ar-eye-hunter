import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { GroupMutationComputed } from '../mutation/group-mutation-contracts.ts';
import type {
  GroupMutationPreparation,
  GroupStateMutationCommand,
  GroupStateService,
} from '../group-state-service-contracts.ts';
// prettier-ignore
import type {
  GroupTopologyManagementService,
} from '../../services/group-topology-management-service.ts';
import type { AppInboxEnqueueInput } from '../../services/AppInboxService.ts';
import { AppInboxType } from '../../services/AppInboxService.ts';
import type {
  WsSessionGenerationCloseFacts,
  WsSessionGenerationLifecycleComputed,
  WsSessionHighWaterIdentity,
} from '../../services/ws-session-generation-lifecycle.ts';
// prettier-ignore
import type {
  GroupPresenceSessionCleanupAppInboxPayload,
} from './group-presence-session-cleanup-app-inbox-payload.ts';

type WriteMutation = (
  write: (transaction: PSqlTransactionSql) => Promise<unknown>,
) => Promise<unknown>;

export class GroupPresenceService {
  static toGroupSessionCleanupEnqueue(
    input: GroupPresenceSessionCleanupAppInboxPayload,
    serviceId: string,
  ): AppInboxEnqueueInput<GroupPresenceSessionCleanupAppInboxPayload> {
    const connection = input.connection;
    return {
      type: AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
      resourceId: [
        'group-presence-session-cleanup',
        connection.authSession.sessionId,
        connection.generationId,
      ]
        .map(encodeURIComponent)
        .join(':'),
      contextId: connection.authSession.sessionId,
      senderId: serviceId,
      data: input,
    };
  }

  static toExpiredPresenceEnqueue(
    preparation: GroupMutationPreparation,
  ): AppInboxEnqueueInput<Readonly<{ commandId: string }>> {
    return {
      type: AppInboxType.GROUP_PRESENCE_EXPIRE,
      resourceId: preparation.queueResourceId,
      authority: preparation,
      data: { commandId: preparation.command.commandId },
    };
  }

  static requireTopologyManagementService(
    service: GroupTopologyManagementService | undefined,
  ): GroupTopologyManagementService {
    if (!service) throw new TypeError('Topology management service is not configured');
    return service;
  }

  static async processConnect(
    input: Readonly<{
      command: GroupStateMutationCommand;
      groupStateService: GroupStateService;
      writeMutation: WriteMutation;
      commitMutation(
        computed: GroupMutationComputed,
        lifecycleGuard: WsSessionGenerationLifecycleComputed,
      ): Promise<unknown>;
    }>,
  ): Promise<unknown> {
    const operation = input.command.command;
    if (operation.operation !== 'connectPresence') {
      throw new TypeError('Group presence connect command is invalid');
    }
    const observedAtEpochMs = operation.input.connectedAtEpochMs ?? input.command.facts.nowEpochMs;
    const identity = toGroupHighWaterIdentity({
      scope: operation.aggregateRef,
      principalId: operation.input.principalId,
      sessionId: operation.sessionId,
    });
    const lifecycle = input.groupStateService.sessionGenerationLifecycle;
    const lifecycleRead = await lifecycle.read(identity);
    if (lifecycle.isObservedAtClosed(identity, observedAtEpochMs, lifecycleRead)) {
      return await input.writeMutation(() =>
        Promise.resolve({
          status: 'inactive',
          sessionId: operation.sessionId,
          generationId: operation.input.generationId,
        }),
      );
    }
    const read = await input.groupStateService.read(input.command);
    const computed = input.groupStateService.compute(input.command, read);
    input.groupStateService.validate(input.command, read, computed);
    const lifecycleGuard = lifecycle.computeConnectGuard(
      {
        ...identity,
        generationId: operation.input.generationId,
        generationStartedAtEpochMs: observedAtEpochMs,
        expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(observedAtEpochMs),
      },
      lifecycleRead,
    );
    return await input.commitMutation(computed, lifecycleGuard);
  }

  static async processSessionCleanup(
    input: Readonly<{
      facts: GroupPresenceSessionCleanupAppInboxPayload;
      attemptCount: number;
      groupStateService: GroupStateService;
      writeMutation: WriteMutation;
      wakeQueue?: () => void;
    }>,
  ): Promise<unknown> {
    const closeFacts = toGroupCloseFacts(input.facts);
    const lifecycle = input.groupStateService.sessionGenerationLifecycle;
    const lifecycleRead = await lifecycle.read(closeFacts);
    const lifecycleComputed = lifecycle.computeClosed(closeFacts, lifecycleRead);
    const preparations = await input.groupStateService.prepareSessionCleanupMutations({
      scope: input.facts.connection.scope,
      authSession: input.facts.connection.authSession,
      principalId: input.facts.connection.principalId,
      disconnectedAtEpochMs: input.facts.disconnectedAtEpochMs,
    });
    const mutations = await Promise.all(
      preparations.map(async (prepared) => {
        const command: GroupStateMutationCommand = {
          authorityProof: prepared.authorityProof,
          descriptor: prepared.descriptor,
          command: prepared.command,
          facts: { ...prepared.facts, attemptCount: input.attemptCount },
        };
        const read = await input.groupStateService.read(command);
        const computed = input.groupStateService.compute(command, read);
        input.groupStateService.validate(command, read, computed);
        return computed;
      }),
    );
    const result = await input.writeMutation(async (transaction) => {
      await lifecycle.write(transaction, lifecycleComputed);
      for (const computed of mutations) {
        if (computed.outcome === 'write') {
          await input.groupStateService.write(transaction, computed);
        }
      }
      return {
        status: 'inactive',
        sessionId: input.facts.connection.authSession.sessionId,
        generationId: input.facts.connection.generationId,
        affectedGroups: mutations.length,
      };
    });
    input.wakeQueue?.();
    return result;
  }
}

export function toGroupSessionCleanupEnqueue(
  input: GroupPresenceSessionCleanupAppInboxPayload,
  serviceId: string,
): AppInboxEnqueueInput<GroupPresenceSessionCleanupAppInboxPayload> {
  return GroupPresenceService.toGroupSessionCleanupEnqueue(input, serviceId);
}

export function toExpiredPresenceEnqueue(
  preparation: GroupMutationPreparation,
): AppInboxEnqueueInput<Readonly<{ commandId: string }>> {
  return GroupPresenceService.toExpiredPresenceEnqueue(preparation);
}

export function requireTopologyManagementService(
  service: GroupTopologyManagementService | undefined,
): GroupTopologyManagementService {
  return GroupPresenceService.requireTopologyManagementService(service);
}

export async function processGroupPresenceConnect(
  input: Readonly<{
    command: GroupStateMutationCommand;
    groupStateService: GroupStateService;
    writeMutation: WriteMutation;
    commitMutation(
      computed: GroupMutationComputed,
      lifecycleGuard: WsSessionGenerationLifecycleComputed,
    ): Promise<unknown>;
  }>,
): Promise<unknown> {
  return await GroupPresenceService.processConnect(input);
}

export async function processGroupSessionCleanup(
  input: Readonly<{
    facts: GroupPresenceSessionCleanupAppInboxPayload;
    attemptCount: number;
    groupStateService: GroupStateService;
    writeMutation: WriteMutation;
    wakeQueue?: () => void;
  }>,
): Promise<unknown> {
  return await GroupPresenceService.processSessionCleanup(input);
}

function toGroupHighWaterIdentity(
  input: Readonly<{
    scope: Readonly<{ applicationId: string; workspaceId: string }>;
    principalId: string;
    sessionId: string;
  }>,
): WsSessionHighWaterIdentity {
  return {
    scope: {
      kind: 'group',
      applicationId: input.scope.applicationId,
      workspaceId: input.scope.workspaceId,
      principalId: input.principalId,
    },
    sessionId: input.sessionId,
  };
}

function toGroupCloseFacts(
  input: GroupPresenceSessionCleanupAppInboxPayload,
): WsSessionGenerationCloseFacts {
  const connection = input.connection;
  return {
    ...toGroupHighWaterIdentity({
      scope: connection.scope,
      principalId: connection.principalId,
      sessionId: connection.authSession.sessionId,
    }),
    generationId: connection.generationId,
    generationStartedAtEpochMs: connection.generationStartedAtEpochMs,
    disconnectedAtEpochMs: input.disconnectedAtEpochMs,
    reason: input.reason,
    expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(input.disconnectedAtEpochMs),
  };
}
