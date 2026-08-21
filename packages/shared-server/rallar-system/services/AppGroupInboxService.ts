import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { PSqlSql } from '../../postgres/PostgresSqlClient.ts';
import { GroupMutationAuthorizationError } from '../group-state/group-mutation-authority.ts';
import type { GroupStateService } from '../group-state/group-state-service-contracts.ts';

import type { GroupFormationGroupMutationSink } from '../formation-metrics.ts';
import { GroupStateInboxHandler } from '../group-state/inbox/group-state-inbox-handler.ts';

import type {
  GroupStateInboxDurableResult,
} from '../group-state/inbox/group-state-inbox-result.ts';

import {
  decodeGroupStateInboxDurableResult,
} from '../group-state/inbox/group-state-inbox-result-codec.ts';

import { toGroupMutationDescriptor } from '../group-state/inbox/to-group-mutation-descriptor.ts';
import {
  GROUP_MUTATION_INBOX_TYPES,
  isAuthenticatedGroupMutationEnqueue,
} from '../group-state/inbox/group-state-inbox-contracts.ts';
import type {
  AuthenticatedGroupMutationEnqueue,
  AuthenticatedGroupMutationInboxType,
  AuthenticatedGroupMutationPayloadByType,
} from '../group-state/inbox/group-state-inbox-contracts.ts';

import type {
  GroupPresenceSessionCleanupAppInboxPayload,
} from '../group-state/presence/group-presence-session-cleanup-app-inbox-payload.ts';
import {
  processGroupSessionCleanup,
  toExpiredPresenceEnqueue,
  toGroupSessionCleanupEnqueue,
} from '../group-state/presence/group-presence-service.ts';

import type { GroupMutationCommand } from '../group-state/mutation/group-mutation-contracts.ts';
import type { IssuedAuthSession } from '../auth/persistence/auth-session-types.ts';

import type {
  RtcRttAppInboxDependencies,
} from '../rtc-topology/inbox/rtc-rtt-app-inbox-contracts.ts';
import { RtcRttAppInboxHandler } from '../rtc-topology/inbox/rtc-rtt-app-inbox-handler.ts';
import {
  decodeTopologyAppInboxResult,
  TopologyAppInboxHandler,
  type TopologyAppInboxResult,
  type TopologyAppInboxMutationOwners,
} from '../topology/inbox/topology-app-inbox-handler.ts';
import {
  readDurableTopologyAppInboxCommand,
  toPersistedTopologyHttpMutationSemanticHash,
  toTopologyAppInboxType,
  toTopologyHttpMutationContextId,
} from '../topology/inbox/topology-app-inbox-command.ts';
import type { TopologyAppInboxCommand } from '../topology/inbox/topology-app-inbox-contracts.ts';

import type {
  GroupTopologyManagementService,
} from '../topology/group-topology-management-service.ts';
import {
  type AppInboxEnqueueInput,
  type AppInboxFailure,
  type AppInboxMessageContext,
  AppInboxService,
  type AppInboxServiceOptions,
  AppInboxIdempotencyConflictError,
  AppInboxType,
  SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
} from './AppInboxService.ts';
import { toStrictAppInboxQueueKey } from './app-inbox-queue-key.ts';
import { toLegacyAppInboxFailure } from './app-inbox-legacy-failure.ts';
import type { RallarTimingSink } from './timing.ts';
import type { JsonWireValue } from './mutation-command-identity.ts';

export {
  type AppInboxEnqueueInput,
  AppInboxService,
  type AppInboxServiceOptions,
  AppInboxType,
} from './AppInboxService.ts';

export {
  AUTHENTICATED_GROUP_INBOX_TYPES,
  type GroupAdmissionDeclineAppInboxPayload,
  type GroupAdmissionGrantAppInboxPayload,
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

export {
  toTopologyAppInboxCommand,
  toTopologyHttpMutationSemanticHash,
} from '../topology/inbox/topology-app-inbox-command.ts';

export {
  decodeTopologyAppInboxResult,
  decodeTopologyReconfigureInboxResult,
  type TopologyAppInboxResult,
  type TopologyReconfigureInboxResult,
} from '../topology/inbox/topology-app-inbox-handler.ts';

export type {
  RtcRttAppInboxCommand,
  RtcRttAppInboxDependencies,
} from '../rtc-topology/inbox/rtc-rtt-app-inbox-contracts.ts';

export type { RtcRttAppInboxResult } from '../rtc-topology/inbox/rtc-rtt-app-inbox-result.ts';

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

export namespace AppGroupInboxService {
  export interface Dependencies {
    readonly inboxQueueReader: InboxQueueReader;
    readonly resourceInboxRepository: AppInboxService.InboxRepository;
    readonly resourceInboxResultsRepository: AppInboxService.ResultRepository;
    readonly database: PSqlSql;
    readonly groupStateService: GroupStateService;
  }

  export interface Config {
    readonly serviceId: string;
    readonly timing?: RallarTimingSink;
    readonly options?: AppInboxServiceOptions;
    readonly wakeOwningQueue?: () => void;
    readonly formationMetrics?: GroupFormationGroupMutationSink;
  }

  export interface HttpTopologyCommandReservation {
    readonly operation: TopologyAppInboxCommand['operation'];
    readonly requestId: string;
    readonly callerId: string;
    readonly groupRef: TopologyAppInboxCommand['groupRef'];
    readonly semanticHash: string;
    readonly materialize: () => Promise<TopologyAppInboxCommand>;
  }
}

class AppGroupInboxService extends AppInboxService {
  private readonly groupStateInboxHandler: GroupStateInboxHandler;
  private readonly topologyAppInboxHandler: TopologyAppInboxHandler;
  private readonly rtcRttAppInboxHandler: RtcRttAppInboxHandler;
  private topologyManagementService?: GroupTopologyManagementService;
  private rtcRttDependencies?: RtcRttAppInboxDependencies;

  public readonly groupStateService: GroupStateService;
  private readonly wakeQueue?: () => void;

  constructor(
    dependencies: AppGroupInboxService.Dependencies,
    config: AppGroupInboxService.Config,
  ) {
    super(
      {
        inboxQueueReader: dependencies.inboxQueueReader,
        resourceInboxRepository: dependencies.resourceInboxRepository,
        resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository,
        database: dependencies.database,
      },
      {
        serviceId: config.serviceId,
        defaultTopicId: SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
        timing: config.timing,
        options: config.options,
        wakeOwningQueue: config.wakeOwningQueue,
      },
    );
    this.groupStateService = dependencies.groupStateService;
    this.wakeQueue = config.wakeOwningQueue;
    this.groupStateInboxHandler = new GroupStateInboxHandler({
      mutationService: this.groupStateService,
      sessionGenerationLifecycle: this.groupStateService.sessionGenerationLifecycle,
      snapshotObserver: this.groupStateService,
      transactionWriter: this.transactionWriter,
      wakeQueue: this.wakeQueue,
      formationMetrics: config.formationMetrics,
      prepareMutation: (descriptor, authority) =>
        this.groupStateService.prepareAppInboxMutation(descriptor, authority),
      persistPreparation: (context, preparation) =>
        this.persistReservedEntryAuthority(context, preparation),
    });
    this.topologyAppInboxHandler = new TopologyAppInboxHandler({
      groupStateService: this.groupStateService,
      transactionWriter: this.transactionWriter,
      nowEpochMs: () => this.nowEpochMs(),
      wakeQueue: this.wakeQueue,
    });
    this.rtcRttAppInboxHandler = new RtcRttAppInboxHandler({
      groupStateService: this.groupStateService,
      writeMutation: async (context, write) => await this.writeMutation(context, write),
      nowEpochMs: () => this.nowEpochMs(),
      wakeQueue: this.wakeQueue,
    });
    this.registerGroupStateMessageHandlers();
  }

  public async enqueueExpiredPresenceSessions(atEpochMs: number): Promise<number> {
    const preparations = await this.groupStateService.prepareExpiredPresenceMutations(atEpochMs);
    for (const preparation of preparations) {
      await super.enqueue(toExpiredPresenceEnqueue(preparation));
    }
    return preparations.length;
  }

  public async enqueueFormationCriterionCommand(
    command: GroupMutationCommand,
    atEpochMs: number,
  ): Promise<void> {
    const preparation = await this.groupStateService.prepareFormationCriterionMutation(
      command,
      atEpochMs,
    );
    await super.enqueue({
      type: AppInboxType.GROUP_FORMATION_CRITERION,
      resourceId: preparation.queueResourceId,
      authority: preparation,
      data: { commandId: preparation.command.commandId },
    });
  }

  public async enqueueGroupSessionCleanup(
    input: GroupPresenceSessionCleanupAppInboxPayload,
  ): Promise<number> {
    await super.enqueue(toGroupSessionCleanupEnqueue(input, this.serviceId));
    return 1;
  }

  public override processEntryNoWaiting<V>(enqueue: AppInboxEnqueueInput<V>): void {
    void enqueue;
    throw new GroupMutationAuthorizationError(
      'Authenticated group mutation authority is required.',
    );
  }

  public override processEntryNoWaitingIf<V>(
    enqueue: AppInboxEnqueueInput<V>,
    enqueueIf: (entry: ResourceEntry) => boolean,
  ): void {
    void enqueue;
    void enqueueIf;
    throw new GroupMutationAuthorizationError(
      'Authenticated group mutation authority is required.',
    );
  }

  public override processEntryUntilCompletion<V>(
    enqueue: AppInboxEnqueueInput<V>,
  ): Promise<Either<string, JsonWireValue>> {
    void enqueue;
    return Promise.reject(
      new GroupMutationAuthorizationError('Authenticated group mutation authority is required.'),
    );
  }

  public override processEntryUntilCompletionIf<V>(
    enqueue: AppInboxEnqueueInput<V>,
    enqueueIf: (entry: ResourceEntry) => boolean,
  ): Promise<Either<string, JsonWireValue>> {
    void enqueue;
    void enqueueIf;
    return Promise.reject(
      new GroupMutationAuthorizationError('Authenticated group mutation authority is required.'),
    );
  }

  public async processAuthenticatedGroupEntryUntilCompletion(
    enqueue: AuthenticatedGroupMutationEnqueue,
    authority: IssuedAuthSession,
  ): Promise<Either<string, GroupStateInboxDurableResult>> {
    const result = await this.processAuthenticatedGroupEntryUntilCompletionResult(
      enqueue,
      authority,
    );
    return result.mapLeft(toLegacyAppInboxFailure);
  }

  public async processAuthenticatedGroupEntryUntilCompletionResult(
    enqueue: AuthenticatedGroupMutationEnqueue,
    authority: IssuedAuthSession,
  ): Promise<Either<AppInboxFailure, GroupStateInboxDurableResult>> {
    if (isTopologyConfigInboxType(enqueue.type)) {
      throw new TypeError('Authenticated group mutation type is required');
    }
    const prepared = await this.prepareAuthenticatedGroupMutation(enqueue, authority);
    return await super.processEntryUntilCompletionResult<
      AuthenticatedGroupMutationPayloadByType[AuthenticatedGroupMutationInboxType],
      GroupStateInboxDurableResult
    >(prepared, (value) => decodeGroupStateInboxDurableResult(value, enqueue.type));
  }

  public async processAuthenticatedTopologyEntryUntilCompletion<V>(
    enqueue: AppInboxEnqueueInput<V>,
    authority: IssuedAuthSession,
  ): Promise<Either<string, TopologyAppInboxResult>> {
    const result = await this.processAuthenticatedTopologyEntryUntilCompletionResult(
      enqueue,
      authority,
    );
    return result.mapLeft(toLegacyAppInboxFailure);
  }

  public async processAuthenticatedTopologyEntryUntilCompletionResult<V>(
    enqueue: AppInboxEnqueueInput<V>,
    authority: IssuedAuthSession,
  ): Promise<Either<AppInboxFailure, TopologyAppInboxResult>> {
    if (!isTopologyConfigInboxType(enqueue.type)) {
      throw new TypeError('Topology AppInbox type is required');
    }
    return await super.processEntryUntilCompletionResult(
      await this.topologyAppInboxHandler.createAuthenticatedEnqueue(enqueue, authority),
      decodeTopologyAppInboxResult,
    );
  }

  public async processAuthenticatedHttpTopologyEntryUntilCompletionResult(
    reservation: AppGroupInboxService.HttpTopologyCommandReservation,
    authority: IssuedAuthSession,
  ): Promise<Either<AppInboxFailure, TopologyAppInboxResult>> {
    const currentSession = await this.topologyAppInboxHandler.validateCurrentSession(
      reservation.callerId,
      authority,
    );
    const type = toTopologyAppInboxType(reservation.operation);
    const key = toStrictAppInboxQueueKey({
      topicId: type,
      resourceId: reservation.requestId,
      contextId: toTopologyHttpMutationContextId(reservation.groupRef, reservation.callerId),
    });
    const reserved = await this.reserveMaterializedEntry(
      {
        type,
        ...key,
        senderId: reservation.callerId,
        data: null,
      },
      async () =>
        await this.topologyAppInboxHandler.createAuthenticatedEnqueueFromValidatedSession(
          {
            type,
            ...key,
            senderId: reservation.callerId,
            data: await reservation.materialize(),
          },
          currentSession,
        ),
    );
    const command = readDurableTopologyAppInboxCommand(reserved.enqueue.data);
    if (
      command.operation !== reservation.operation ||
      command.requestId !== reservation.requestId ||
      command.actor.principalId !== reservation.callerId ||
      !sameGroupRef(command.groupRef, reservation.groupRef) ||
      reserved.enqueue.type !== type ||
      reserved.enqueue.topicId !== key.topicId ||
      reserved.enqueue.resourceId !== key.resourceId ||
      reserved.enqueue.contextId !== key.contextId ||
      reserved.enqueue.senderId !== reservation.callerId ||
      (await toPersistedTopologyHttpMutationSemanticHash(command)) !== reservation.semanticHash
    ) {
      throw new AppInboxIdempotencyConflictError(
        reservation.requestId,
        command.commandHash,
        reservation.semanticHash,
      );
    }
    return await this.waitForReservedEntryResult(
      reserved.enqueue,
      decodeTopologyAppInboxResult,
      reserved.winner,
    );
  }

  setTopologyManagementService(service: GroupTopologyManagementService): void {
    if (this.topologyManagementService) {
      if (this.topologyManagementService !== service) {
        throw new TypeError('Topology management service is already configured');
      }
      return;
    }
    const owners = requireTopologyAppInboxMutationOwners(service);
    this.topologyManagementService = service;
    this.registerTopologyStateMessageHandlers(owners);
  }

  setRtcRttAppInboxDependencies(dependencies: RtcRttAppInboxDependencies): void {
    if (this.rtcRttDependencies) {
      if (this.rtcRttDependencies !== dependencies) {
        throw new TypeError('RTC RTT AppInbox dependencies are already configured');
      }
      return;
    }
    this.rtcRttDependencies = dependencies;
    this.registerRtcRttStateMessageHandler(dependencies);
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

  private async prepareAuthenticatedGroupMutation(
    enqueue: AuthenticatedGroupMutationEnqueue,
    authority: IssuedAuthSession,
  ): Promise<AuthenticatedGroupMutationEnqueue> {
    if (!isAuthenticatedGroupMutationEnqueue(enqueue)) {
      throw new GroupMutationAuthorizationError(
        'App inbox type is not an authenticated group mutation.',
      );
    }
    const authorized = await this.groupStateService.authorizeMutation(
      toGroupMutationDescriptor(enqueue),
      authority,
    );
    return {
      ...enqueue,
      authority: authorized,
    };
  }

  private registerGroupStateMessageHandlers(): void {
    const processGroupMutation = async (_payload: JsonWireValue, context: AppInboxMessageContext) =>
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
  }

  private registerTopologyStateMessageHandlers(owners: TopologyAppInboxMutationOwners): void {
    for (const type of TOPOLOGY_CONFIG_INBOX_TYPES) {
      this.onStateMessage(
        type,
        async (_payload, context) =>
          await this.topologyAppInboxHandler.processMutation(context, owners),
      );
    }
  }

  private registerRtcRttStateMessageHandler(dependencies: RtcRttAppInboxDependencies): void {
    this.onStateMessage(
      AppInboxType.RTC_RTT_SUBMIT,
      async (_payload, context) =>
        await this.rtcRttAppInboxHandler.processMutation(context, dependencies),
    );
  }
}

function sameGroupRef(
  left: TopologyAppInboxCommand['groupRef'],
  right: TopologyAppInboxCommand['groupRef'],
): boolean {
  return (
    left.applicationId === right.applicationId &&
    left.workspaceId === right.workspaceId &&
    left.groupId === right.groupId
  );
}

function requireTopologyAppInboxMutationOwners(
  service: GroupTopologyManagementService,
): TopologyAppInboxMutationOwners {
  if (!service.configMutationService || !service.reconfigureMutation) {
    throw new TypeError('Topology AppInbox mutations require config and reconfigure owners');
  }
  return {
    configMutationService: service.configMutationService,
    reconfigureMutation: service.reconfigureMutation,
  };
}

export { AppGroupInboxService };
