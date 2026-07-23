import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import type { GroupMutationComputed } from './group-state-mutations.ts';
import type {
  GroupMutationPreparation,
  GroupStateMutationCommand,
  GroupStateService,
} from './group-state-service.ts';
import type { GroupTopologyManagementService } from './group-topology-management-service.ts';
import type { AppInboxEnqueueInput } from './AppInboxService.ts';
import { AppInboxType } from './AppInboxService.ts';
import type {
  WsSessionGenerationCloseFacts,
  WsSessionGenerationLifecycleComputed,
} from './ws-session-generation-lifecycle.ts';

export type GroupPresenceSessionCleanupAppInboxPayload = WsSessionGenerationCloseFacts;

export function toGroupSessionCleanupEnqueue(
  input: GroupPresenceSessionCleanupAppInboxPayload,
  serviceId: string,
): AppInboxEnqueueInput<GroupPresenceSessionCleanupAppInboxPayload> {
  return {
    type: AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
    resourceId: ['group-presence-session-cleanup', input.sessionId, input.generationId]
      .map(encodeURIComponent).join(':'),
    contextId: input.sessionId,
    senderId: serviceId,
    data: input,
  };
}

export function toExpiredPresenceEnqueue(
  preparation: GroupMutationPreparation,
): AppInboxEnqueueInput<Readonly<{ commandId: string }>> {
  return {
    type: AppInboxType.GROUP_PRESENCE_EXPIRE,
    resourceId: preparation.queueResourceId,
    authority: preparation,
    data: { commandId: preparation.command.commandId },
  };
}

export function requireTopologyManagementService(
  service: GroupTopologyManagementService | undefined,
): GroupTopologyManagementService {
  if (!service) throw new TypeError('Topology management service is not configured');
  return service;
}

type WriteMutation = (
  write: (transaction: PSqlTransactionSql) => Promise<unknown>,
) => Promise<unknown>;

export async function processGroupPresenceConnect(
  input: Readonly<{
    command: GroupStateMutationCommand;
    groupStateService: GroupStateService;
    writeMutation: WriteMutation;
    commitMutation(
      computed: GroupMutationComputed,
      lifecycle: WsSessionGenerationLifecycleComputed,
    ): Promise<unknown>;
  }>,
): Promise<unknown> {
  const operation = input.command.command;
  if (operation.operation !== 'connectPresence') {
    throw new TypeError('Group presence connect command is invalid');
  }
  const facts = {
    sessionId: operation.sessionId,
    generationId: operation.input.generationId,
    generationStartedAtEpochMs: operation.input.connectedAtEpochMs ??
      input.command.facts.nowEpochMs,
  };
  const lifecycle = input.groupStateService.sessionGenerationLifecycle;
  const lifecycleRead = await lifecycle.read(facts);
  const lifecycleComputed = lifecycle.computeOpen(facts, lifecycleRead);
  if (lifecycleComputed.state.status === 'closed') {
    return await input.writeMutation(() =>
      Promise.resolve({
        status: 'inactive',
        sessionId: facts.sessionId,
        generationId: facts.generationId,
      })
    );
  }
  const read = await input.groupStateService.read(input.command);
  const computed = input.groupStateService.compute(input.command, read);
  input.groupStateService.validate(input.command, read, computed);
  return await input.commitMutation(computed, lifecycleComputed);
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
  const lifecycle = input.groupStateService.sessionGenerationLifecycle;
  const lifecycleRead = await lifecycle.read(input.facts);
  const lifecycleComputed = lifecycle.computeClosed(input.facts, lifecycleRead);
  const preparations = await input.groupStateService.prepareSessionCleanupMutations(input.facts);
  const mutations = await Promise.all(preparations.map(async (prepared) => {
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
  }));
  const result = await input.writeMutation(async (transaction) => {
    await lifecycle.write(transaction, lifecycleComputed);
    for (const computed of mutations) {
      if (computed.outcome === 'write') {
        await input.groupStateService.write(transaction, computed);
      }
    }
    return {
      status: 'inactive',
      sessionId: input.facts.sessionId,
      generationId: input.facts.generationId,
      affectedGroups: mutations.length,
    };
  });
  input.wakeQueue?.();
  return result;
}
