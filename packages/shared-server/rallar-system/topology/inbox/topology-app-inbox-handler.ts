// prettier-ignore
import {
  fromCanonicalGroupTopologyConfigPatch,
} from '@shared/api/group-topology-config-canonical.ts';

import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import type { IssuedAuthSession } from '../../repositories/auth-session-types.ts';
import { GroupPresenceService } from '../../group-state/presence/group-presence-service.ts';
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
  readonly writeMutation: (
    context: AppInboxMessageContext,
    write: (transaction: PSqlTransactionSql) => Promise<unknown>,
  ) => Promise<unknown>;
  readonly nowEpochMs: () => number;
  readonly wakeQueue?: () => void;
}

export class TopologyAppInboxHandler {
  private topologyManagementService?: GroupTopologyManagementService;

  constructor(private readonly dependencies: TopologyAppInboxHandlerDependencies) {}

  setTopologyManagementService(service: GroupTopologyManagementService): void {
    if (this.topologyManagementService && this.topologyManagementService !== service) {
      throw new TypeError('Topology management service is already configured');
    }
    this.topologyManagementService = service;
  }

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

  async processMutation(context: AppInboxMessageContext): Promise<unknown> {
    const authority = readTopologyAppInboxAuthority(context.enqueue.authority);
    await verifyTopologyAppInboxAuthority({
      authority,
      groupStateService: this.dependencies.groupStateService,
      nowEpochMs: this.dependencies.nowEpochMs,
    });
    if (authority.kind === 'topology-reconfigure') {
      return await this.processTopologyReconfigureMutation(context, authority);
    }
    const service = GroupPresenceService.requireTopologyManagementService(
      this.topologyManagementService,
    );
    const preparation = await service.prepareTopologyConfigMutation({
      command: toTopologyConfigMutationCommand(authority.command),
      commandHash: authority.command.commandHash,
      capturedAtEpochMs: authority.command.capturedAtEpochMs,
    });
    const read = await service.readTopologyConfigMutation(preparation.command);
    const attemptCount = context.entry.dequeueAudit.attempts;
    const computed = service.computeTopologyConfigMutation(preparation, read, attemptCount);
    service.validateTopologyConfigMutation(preparation, read, attemptCount, computed);
    if (computed.outcome === 'idempotency-conflict') {
      throw new GroupTopologyConfigIdempotencyConflictError(
        computed.existingCommandHash,
        computed.receivedCommandHash,
      );
    }
    const result = await this.dependencies.writeMutation(context, async (transaction) => {
      if (computed.outcome === 'write' || computed.outcome === 'claim') {
        await service.writeTopologyConfigMutation(transaction, computed);
      }
      return service.toTopologyConfigMutationResult(computed);
    });
    if (computed.outcome === 'write') this.dependencies.wakeQueue?.();
    return result;
  }

  private async processTopologyReconfigureMutation(
    context: AppInboxMessageContext,
    authority: TopologyReconfigureAppInboxAuthority,
  ): Promise<unknown> {
    const service = GroupPresenceService.requireTopologyManagementService(
      this.topologyManagementService,
    );
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
      isPlatformAdmin: service.isPlatformAdmin(authority.command.actor.principalId),
    };
    const read = await service.readTopologyMutation(command);
    const computed = service.computeTopologyMutation(command, read);
    service.validateTopologyMutation(command, read, computed);
    const result = await this.dependencies.writeMutation(context, async (transaction) => {
      await service.writeTopologyMutation(transaction, computed);
      return {
        status: 'queued',
        groupRef: command.groupRef,
        requestId: command.commandId,
        outboxId: computed.resourceId,
      };
    });
    this.dependencies.wakeQueue?.();
    return result;
  }
}
