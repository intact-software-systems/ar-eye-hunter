// prettier-ignore
import {
  fromCanonicalGroupTopologyConfigPatch,
} from '@shared/api/group-topology-config-canonical.ts';

import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
// prettier-ignore
import type {
  AppInboxMutationTransactionWriter,
} from '../../services/app-inbox-transaction-writer.ts';
import type {
  AppInboxEnqueueInput,
  AppInboxMessageContext,
} from '../../services/AppInboxService.ts';
// prettier-ignore
import type {
  GroupTopologyConfigMutationService,
} from '../config/group-topology-config-mutation-service.ts';
// prettier-ignore
import {
  toTopologyConfigMutationResult,
} from '../config/mutation/to-topology-config-mutation-result.ts';
import { writeTopologyConfigMutation } from '../config/mutation/write-topology-config-mutation.ts';
import { GroupTopologyConfigIdempotencyConflictError } from '../group-topology-errors.ts';
// prettier-ignore
import type {
  GroupTopologyReconfigureCommand,
} from '../reconfigure/group-topology-reconfigure-contracts.ts';
// prettier-ignore
import type {
  GroupTopologyReconfigureMutation,
} from '../reconfigure/group-topology-reconfigure-mutation.ts';
import {
  createAuthenticatedTopologyEnqueue,
  readTopologyAppInboxAuthority,
  verifyTopologyAppInboxAuthority,
} from './topology-app-inbox-authority.ts';
import { toTopologyConfigMutationCommand } from './topology-app-inbox-command.ts';
import type { TopologyReconfigureAppInboxAuthority } from './topology-app-inbox-contracts.ts';

export interface TopologyAppInboxHandlerDependencies {
  readonly groupStateService: GroupStateService;
  readonly transactionWriter: Pick<AppInboxMutationTransactionWriter, 'writeMutation'>;
  readonly nowEpochMs: () => number;
  readonly wakeQueue?: () => void;
}

export interface TopologyAppInboxMutationOwners {
  readonly configMutationService: Pick<
    GroupTopologyConfigMutationService,
    'prepare' | 'read' | 'compute' | 'validate'
  >;
  readonly reconfigureMutation: Pick<
    GroupTopologyReconfigureMutation,
    'read' | 'compute' | 'validate' | 'write'
  >;
}

type TopologyConfigInboxResult = ReturnType<typeof toTopologyConfigMutationResult>;

interface TopologyReconfigureInboxResult {
  readonly status: 'queued';
  readonly groupRef: GroupTopologyReconfigureCommand['groupRef'];
  readonly requestId: string;
  readonly outboxId: string;
}

type TopologyAppInboxResult = TopologyConfigInboxResult | TopologyReconfigureInboxResult;

export class TopologyAppInboxHandler {
  private readonly dependencies: TopologyAppInboxHandlerDependencies;

  constructor(dependencies: TopologyAppInboxHandlerDependencies) {
    this.dependencies = dependencies;
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

  async processMutation(
    context: AppInboxMessageContext,
    owners: TopologyAppInboxMutationOwners,
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
        owners.reconfigureMutation,
      );
    }
    const preparation = await owners.configMutationService.prepare({
      command: toTopologyConfigMutationCommand(authority.command),
      commandHash: authority.command.commandHash,
      capturedAtEpochMs: authority.command.capturedAtEpochMs,
    });
    const read = await owners.configMutationService.read(preparation.command);
    const attemptCount = context.entry.dequeueAudit.attempts;
    const computed = owners.configMutationService.compute(preparation, read, attemptCount);
    owners.configMutationService.validate(preparation, read, attemptCount, computed);
    if (computed.outcome === 'idempotency-conflict') {
      throw new GroupTopologyConfigIdempotencyConflictError(
        computed.existingCommandHash,
        computed.receivedCommandHash,
      );
    }
    const result = await this.dependencies.transactionWriter.writeMutation(
      context,
      async (transaction) => {
        if (computed.outcome === 'write' || computed.outcome === 'claim') {
          await writeTopologyConfigMutation(transaction, computed);
        }
        return toTopologyConfigMutationResult(computed);
      },
    );
    if (computed.outcome === 'write') {
      this.dependencies.wakeQueue?.();
    }
    return result;
  }

  private async processTopologyReconfigureMutation(
    context: AppInboxMessageContext,
    authority: TopologyReconfigureAppInboxAuthority,
    mutation: TopologyAppInboxMutationOwners['reconfigureMutation'],
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
    };
    const read = await mutation.read(command);
    const computed = mutation.compute(command, read);
    mutation.validate(command, read, computed);
    const result = await this.dependencies.transactionWriter.writeMutation(
      context,
      async (transaction) => {
        await mutation.write(transaction, computed);
        return {
          status: 'queued',
          groupRef: command.groupRef,
          requestId: command.commandId,
          outboxId: computed.resourceId,
        } as const;
      },
    );
    this.dependencies.wakeQueue?.();
    return result;
  }
}
