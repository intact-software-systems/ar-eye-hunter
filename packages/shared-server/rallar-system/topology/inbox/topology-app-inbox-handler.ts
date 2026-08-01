// prettier-ignore
import {
  fromCanonicalGroupTopologyConfigPatch,
} from '@shared/api/group-topology-config-canonical.ts';

import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import type { IssuedAuthSession } from '../../repositories/auth-session-types.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
import {
  GroupTopologyConfigIdempotencyConflictError,
  type GroupTopologyManagementService,
  type GroupTopologyReconfigureCommand,
} from '../../services/group-topology-management-service.ts';
import type {
  AppInboxEnqueueInput,
  AppInboxMessageContext,
} from '../../services/AppInboxService.ts';
import {
  createAuthenticatedTopologyEnqueue,
  readTopologyAppInboxAuthority,
  verifyTopologyAppInboxAuthority,
} from './topology-app-inbox-authority.ts';
import { toTopologyConfigMutationCommand } from './topology-app-inbox-command.ts';
import type { TopologyReconfigureAppInboxAuthority } from './topology-app-inbox-contracts.ts';

export interface TopologyAppInboxHandlerDependencies {
  readonly groupStateService: GroupStateService;
  readonly writeMutation: <Result>(
    context: AppInboxMessageContext,
    write: (transaction: PSqlTransactionSql) => Promise<Result>,
  ) => Promise<Result>;
  readonly nowEpochMs: () => number;
  readonly wakeQueue?: () => void;
}

type TopologyConfigInboxResult = ReturnType<
  GroupTopologyManagementService['toTopologyConfigMutationResult']
>;

interface TopologyReconfigureInboxResult {
  readonly status: 'queued';
  readonly groupRef: GroupTopologyReconfigureCommand['groupRef'];
  readonly requestId: string;
  readonly outboxId: string;
}

type TopologyAppInboxResult = TopologyConfigInboxResult | TopologyReconfigureInboxResult;

export class TopologyAppInboxHandler {
  constructor(private readonly dependencies: TopologyAppInboxHandlerDependencies) {}

  async createAuthenticatedEnqueue<V>(
    enqueue: AppInboxEnqueueInput<V>,
    authority: IssuedAuthSession,
  ): Promise<AppInboxEnqueueInput<V>> {
    return await createAuthenticatedTopologyEnqueue({
      enqueue,
      claimedAuthority: authority,
      groupStateService: this.dependencies.groupStateService,
      nowEpochMs: this.dependencies.nowEpochMs,
    });
  }

  async processMutation(
    context: AppInboxMessageContext,
    topologyManagementService: GroupTopologyManagementService,
  ): Promise<TopologyAppInboxResult> {
    const authority = readTopologyAppInboxAuthority(context.enqueue.authority);
    await verifyTopologyAppInboxAuthority({
      authority,
      groupStateService: this.dependencies.groupStateService,
      nowEpochMs: this.dependencies.nowEpochMs,
    });
    if (authority.kind === 'topology-reconfigure') {
      return await this.processTopologyReconfigureMutation(
        context,
        authority,
        topologyManagementService,
      );
    }
    const preparation = await topologyManagementService.prepareTopologyConfigMutation({
      command: toTopologyConfigMutationCommand(authority.command),
      commandHash: authority.command.commandHash,
      capturedAtEpochMs: authority.command.capturedAtEpochMs,
    });
    const read = await topologyManagementService.readTopologyConfigMutation(preparation.command);
    const attemptCount = context.entry.dequeueAudit.attempts;
    const computed = topologyManagementService.computeTopologyConfigMutation(
      preparation,
      read,
      attemptCount,
    );
    topologyManagementService.validateTopologyConfigMutation(
      preparation,
      read,
      attemptCount,
      computed,
    );
    if (computed.outcome === 'idempotency-conflict') {
      throw new GroupTopologyConfigIdempotencyConflictError(
        computed.existingCommandHash,
        computed.receivedCommandHash,
      );
    }
    const result = await this.dependencies.writeMutation(context, async (transaction) => {
      if (computed.outcome === 'write' || computed.outcome === 'claim') {
        await topologyManagementService.writeTopologyConfigMutation(transaction, computed);
      }
      return topologyManagementService.toTopologyConfigMutationResult(computed);
    });
    if (computed.outcome === 'write') this.dependencies.wakeQueue?.();
    return result;
  }

  private async processTopologyReconfigureMutation(
    context: AppInboxMessageContext,
    authority: TopologyReconfigureAppInboxAuthority,
    topologyManagementService: GroupTopologyManagementService,
  ): Promise<TopologyReconfigureInboxResult> {
    if (authority.command.payload.operation !== 'reconfigureTopology') {
      throw new TypeError('Topology reconfigure authority operation is invalid');
    }
    const command: GroupTopologyReconfigureCommand = {
      groupRef: authority.command.groupRef,
      commandId: authority.command.requestId,
      actorPrincipalId: authority.command.actor.principalId,
      capturedAtEpochMs: authority.command.capturedAtEpochMs,
      requestOptions: fromCanonicalGroupTopologyConfigPatch(
        authority.command.payload.requestOptions,
      ),
      publish: authority.command.payload.publish,
      isPlatformAdmin: topologyManagementService.isPlatformAdmin(
        authority.command.actor.principalId,
      ),
    };
    const read = await topologyManagementService.readTopologyMutation(command);
    const computed = topologyManagementService.computeTopologyMutation(command, read);
    topologyManagementService.validateTopologyMutation(command, read, computed);
    const result = await this.dependencies.writeMutation(context, async (transaction) => {
      await topologyManagementService.writeTopologyMutation(transaction, computed);
      return {
        status: 'queued',
        groupRef: command.groupRef,
        requestId: command.commandId,
        outboxId: computed.resourceId,
      } as const;
    });
    this.dependencies.wakeQueue?.();
    return result;
  }
}

export function requireTopologyManagementService(
  service: GroupTopologyManagementService | undefined,
): GroupTopologyManagementService {
  if (!service) throw new TypeError('Topology management service is not configured');
  return service;
}
