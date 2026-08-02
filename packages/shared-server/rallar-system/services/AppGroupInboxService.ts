import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { PSqlSql } from '../../postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '../../postgres/resource-inbox/ResourceInboxRepository.ts';
// prettier-ignore
import {
  ResourceInboxResultsRepository,
} from '../../postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { GroupMutationAuthorizationError } from '../group-state/group-mutation-authority.ts';
import type { GroupStateService } from '../group-state/group-state-service-contracts.ts';
import { GroupStateInboxHandler } from '../group-state/inbox/group-state-inbox-handler.ts';
// prettier-ignore
import { toGroupMutationDescriptor } from
  '../group-state/inbox/to-group-mutation-descriptor.ts';
import {
  GROUP_MUTATION_INBOX_TYPES,
  isAuthenticatedGroupMutationInboxType,
} from '../group-state/inbox/group-state-inbox-contracts.ts';
// prettier-ignore
import type {
  GroupPresenceSessionCleanupAppInboxPayload,
} from '../group-state/presence/group-presence-session-cleanup-app-inbox-payload.ts';
import {
  processGroupSessionCleanup,
  toExpiredPresenceEnqueue,
  toGroupSessionCleanupEnqueue,
} from '../group-state/presence/group-presence-service.ts';
import type { IssuedAuthSession } from '../repositories/auth-session-types.ts';
// prettier-ignore
import type {
  RtcRttAppInboxDependencies,
} from '../rtc-topology/inbox/rtc-rtt-app-inbox-contracts.ts';
import { RtcRttAppInboxHandler } from '../rtc-topology/inbox/rtc-rtt-app-inbox-handler.ts';
import {
  requireTopologyManagementService,
  TopologyAppInboxHandler,
} from '../topology/inbox/topology-app-inbox-handler.ts';
import type { GroupTopologyManagementService } from './group-topology-management-service.ts';
import {
  type AppInboxEnqueueInput,
  type AppInboxFailure,
  type AppInboxMessageContext,
  AppInboxService,
  type AppInboxServiceOptions,
  AppInboxType,
  SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
} from './AppInboxService.ts';
import type { RallarTimingSink } from './timing.ts';

export {
  type AppInboxEnqueueInput,
  AppInboxService,
  type AppInboxServiceOptions,
  AppInboxType,
} from './AppInboxService.ts';

export {
  AUTHENTICATED_GROUP_INBOX_TYPES,
  type GroupCreateAppInboxPayload,
  type GroupDirectorAppointAppInboxPayload,
  type GroupInviteAcceptAppInboxPayload,
  type GroupInviteCreateAppInboxPayload,
  type GroupInviteRevokeAppInboxPayload,
  type GroupJoinAppInboxPayload,
  type GroupJoinCodeRotateAppInboxPayload,
  type GroupMemberBanAppInboxPayload,
  type GroupMemberRemoveAppInboxPayload,
  type GroupMemberRoleSetAppInboxPayload,
  type GroupMemberUnbanAppInboxPayload,
  type GroupMemberUpsertAppInboxPayload,
  type GroupOwnershipTransferAppInboxPayload,
  type GroupPresenceConnectAppInboxPayload,
  type GroupPresenceDisconnectAppInboxPayload,
  type GroupPresenceHeartbeatAppInboxPayload,
  type GroupUpdateAppInboxPayload,
} from '../group-state/inbox/group-state-inbox-contracts.ts';

// prettier-ignore
export type {
  GroupPresenceSessionCleanupAppInboxPayload,
} from '../group-state/presence/group-presence-session-cleanup-app-inbox-payload.ts';

export type {
  CreateTopologyAppInboxCommandInput,
  TopologyAppInboxCommand,
  TopologyAppInboxOperation,
  TopologyAppInboxPayload,
  TopologyAppInboxRequestPayload,
} from '../topology/inbox/topology-app-inbox-contracts.ts';

export { toTopologyAppInboxCommand } from '../topology/inbox/topology-app-inbox-command.ts';

export type {
  RtcRttAppInboxCommand,
  RtcRttAppInboxDependencies,
} from '../rtc-topology/inbox/rtc-rtt-app-inbox-contracts.ts';

export type { RtcRttAppInboxResult } from './rtc-rtt-app-inbox-result.ts';

const TOPOLOGY_CONFIG_INBOX_TYPES = [
  AppInboxType.TOPOLOGY_CONFIG_PUT,
  AppInboxType.TOPOLOGY_CONFIG_DELETE,
  AppInboxType.TOPOLOGY_OVERRIDE_PUT,
  AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
  AppInboxType.TOPOLOGY_RECONFIGURE,
] as const;

function isTopologyConfigInboxType(type: AppInboxType): boolean {
  return (TOPOLOGY_CONFIG_INBOX_TYPES as readonly AppInboxType[]).includes(type);
}

class AppGroupInboxService extends AppInboxService {
  private readonly groupStateInboxHandler: GroupStateInboxHandler;
  private readonly topologyAppInboxHandler: TopologyAppInboxHandler;
  private readonly rtcRttAppInboxHandler: RtcRttAppInboxHandler;
  private topologyManagementService?: GroupTopologyManagementService;
  private rtcRttDependencies?: RtcRttAppInboxDependencies;

  constructor(
    public override readonly inbox: InboxQueueReader,
    public override readonly resourceInbox: ResourceInboxRepository,
    public override readonly resourceInboxResults: ResourceInboxResultsRepository,
    database: PSqlSql,
    public readonly groupStateService: GroupStateService,
    public override readonly serviceId: string,
    timing?: RallarTimingSink,
    options?: AppInboxServiceOptions,
    private readonly wakeQueue?: () => void,
  ) {
    super(
      inbox,
      resourceInbox,
      resourceInboxResults,
      database,
      serviceId,
      SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
      timing,
      options,
      wakeQueue,
    );
    this.groupStateInboxHandler = new GroupStateInboxHandler({
      groupStateService: this.groupStateService,
      writeMutation: async (context, write) => await this.writeMutation(context, write),
      wakeQueue: this.wakeQueue,
    });
    this.topologyAppInboxHandler = new TopologyAppInboxHandler({
      groupStateService: this.groupStateService,
      writeMutation: async (context, write) => await this.writeMutation(context, write),
      nowEpochMs: () => this.nowEpochMs(),
      wakeQueue: this.wakeQueue,
    });
    this.rtcRttAppInboxHandler = new RtcRttAppInboxHandler({
      groupStateService: this.groupStateService,
      writeMutation: async (context, write) => await this.writeMutation(context, write),
      nowEpochMs: () => this.nowEpochMs(),
      wakeQueue: this.wakeQueue,
    });
    this.registerStateMessageHandlers();
  }

  public async enqueueExpiredPresenceSessions(atEpochMs: number): Promise<number> {
    const preparations = await this.groupStateService.prepareExpiredPresenceMutations(atEpochMs);
    for (const preparation of preparations) {
      await super.enqueue(toExpiredPresenceEnqueue(preparation));
    }
    return preparations.length;
  }

  public async enqueueGroupSessionCleanup(
    input: GroupPresenceSessionCleanupAppInboxPayload,
  ): Promise<number> {
    await super.enqueue(toGroupSessionCleanupEnqueue(input, this.serviceId));
    return 1;
  }

  public override processEntryNoWaiting<V, R = V>(enqueue: AppInboxEnqueueInput<V>): void {
    void enqueue;
    throw new GroupMutationAuthorizationError(
      'Authenticated group mutation authority is required.',
    );
  }

  public override processEntryNoWaitingIf<V, R = V>(
    enqueue: AppInboxEnqueueInput<V>,
    enqueueIf: (entry: ResourceEntry) => boolean,
  ): void {
    void enqueue;
    void enqueueIf;
    throw new GroupMutationAuthorizationError(
      'Authenticated group mutation authority is required.',
    );
  }

  public override processEntryUntilCompletion<V, R = V>(
    enqueue: AppInboxEnqueueInput<V>,
  ): Promise<Either<string, R>> {
    void enqueue;
    return Promise.reject(
      new GroupMutationAuthorizationError('Authenticated group mutation authority is required.'),
    );
  }

  public override processEntryUntilCompletionIf<V, R = V>(
    enqueue: AppInboxEnqueueInput<V>,
    enqueueIf: (entry: ResourceEntry) => boolean,
  ): Promise<Either<string, R>> {
    void enqueue;
    void enqueueIf;
    return Promise.reject(
      new GroupMutationAuthorizationError('Authenticated group mutation authority is required.'),
    );
  }

  public async processAuthenticatedEntryUntilCompletion<V, R = V>(
    enqueue: AppInboxEnqueueInput<V>,
    authority: IssuedAuthSession,
  ): Promise<Either<string, R>> {
    if (isTopologyConfigInboxType(enqueue.type)) {
      return await super.processEntryUntilCompletion<V, R>(
        await this.topologyAppInboxHandler.createAuthenticatedEnqueue(enqueue, authority),
      );
    }
    const prepared = await this.prepareAuthenticatedGroupMutation(enqueue, authority);
    return await super.processEntryUntilCompletion<V, R>(prepared);
  }

  public async processAuthenticatedEntryUntilCompletionResult<V, R = V>(
    enqueue: AppInboxEnqueueInput<V>,
    authority: IssuedAuthSession,
  ): Promise<Either<AppInboxFailure, R>> {
    if (isTopologyConfigInboxType(enqueue.type)) {
      return await super.processEntryUntilCompletionResult<V, R>(
        await this.topologyAppInboxHandler.createAuthenticatedEnqueue(enqueue, authority),
      );
    }
    const prepared = await this.prepareAuthenticatedGroupMutation(enqueue, authority);
    return await super.processEntryUntilCompletionResult<V, R>(prepared);
  }

  setTopologyManagementService(service: GroupTopologyManagementService): void {
    if (this.topologyManagementService && this.topologyManagementService !== service) {
      throw new TypeError('Topology management service is already configured');
    }
    this.topologyManagementService = service;
  }

  setRtcRttAppInboxDependencies(dependencies: RtcRttAppInboxDependencies): void {
    if (this.rtcRttDependencies && this.rtcRttDependencies !== dependencies) {
      throw new TypeError('RTC RTT AppInbox dependencies are already configured');
    }
    this.rtcRttDependencies = dependencies;
  }

  async enqueueRtcRtt(
    input: Readonly<{
      rtt: RttMeasurementInfo;
      alSenderId: string;
      capturedAtEpochMs: number;
    }>,
  ): Promise<ResourceEntry> {
    return await super.enqueue(await this.rtcRttAppInboxHandler.createEnqueue(input));
  }

  private async prepareAuthenticatedGroupMutation<V>(
    enqueue: AppInboxEnqueueInput<V>,
    authority: IssuedAuthSession,
  ): Promise<AppInboxEnqueueInput<V>> {
    if (!isAuthenticatedGroupMutationInboxType(enqueue.type)) {
      throw new GroupMutationAuthorizationError(
        'App inbox type is not an authenticated group mutation.',
      );
    }
    const preparation = await this.groupStateService.prepareMutation(
      toGroupMutationDescriptor(enqueue),
      authority,
    );
    return {
      ...enqueue,
      resourceId: preparation.queueResourceId,
      authority: preparation,
    };
  }

  private registerStateMessageHandlers(): void {
    const processGroupMutation = async (_payload: unknown, context: AppInboxMessageContext) =>
      await this.groupStateInboxHandler.processGroupStateMutation(context);
    for (const type of GROUP_MUTATION_INBOX_TYPES.filter(
      (candidate) => candidate !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
    )) {
      this.onStateMessage(type, processGroupMutation);
    }
    this.onStateMessage<GroupPresenceSessionCleanupAppInboxPayload>(
      AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
      async (payload, context) =>
        await processGroupSessionCleanup({
          facts: payload,
          attemptCount: context.entry.dequeueAudit.attempts,
          groupStateService: this.groupStateService,
          writeMutation: async (write) => await this.writeMutation(context, write),
          wakeQueue: this.wakeQueue,
        }),
    );
    for (const type of TOPOLOGY_CONFIG_INBOX_TYPES) {
      this.onStateMessage(
        type,
        async (_payload, context) =>
          await this.topologyAppInboxHandler.processMutation(
            context,
            requireTopologyManagementService(this.topologyManagementService),
          ),
      );
    }
    this.onStateMessage(
      AppInboxType.RTC_RTT_SUBMIT,
      async (_payload, context) =>
        await this.rtcRttAppInboxHandler.processMutation(
          context,
          this.requireRtcRttAppInboxDependencies(),
        ),
    );
  }

  private requireRtcRttAppInboxDependencies(): RtcRttAppInboxDependencies {
    if (!this.rtcRttDependencies) {
      throw new TypeError('RTC RTT AppInbox dependencies are not configured');
    }
    return this.rtcRttDependencies;
  }
}

export { AppGroupInboxService };
