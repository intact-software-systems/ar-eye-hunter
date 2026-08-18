import { AppTopics, type RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { QRtcSignalingMessage } from '@shared/webrtc/QRtcSignalingContracts.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import {
  type DynamicWsTopicRouterOptions,
  initDynamicWsTopicRouter,
} from '../rallar-facade/ws-topic-router.ts';
import { sendStateSyncMessage } from './state-sync-routing.ts';
import {
  createRtcTopologyOutboxPublisher,
  createRtcTopologyWorkHandler,
  type RtcTopologyDeliveryOptions,
  type RtcTopologyWorkPublisher,
} from './services/RtcTopologyOutboxWork.ts';
import {
  RallarRtcTopologyService,
  type RallarRtcTopologyServiceOptions,
} from './services/rallar-rtc-topology-service.ts';
import type {
  GroupTopologyManagementService,
  GroupTopologyGroupSnapshotReader,
} from './topology/group-topology-management-service.ts';
import type { RuntimeStateRepositoryLike } from '../runtime-state/RuntimeStateRepository.ts';
import type { RtcTopologyExecutionRepository } from './repositories/RtcTopologyExecutionRepository.ts';
import type { PSqlSql } from '../postgres/PostgresSqlClient.ts';
import { type RtcTopologyRuntimeState } from './ws-rtc-topology-runtime.ts';
import {
  computeGlobalGraphAndCacheItIfPossible,
  initRtcRttTopic,
} from './rtc-topology/topic/init-rtc-rtt-topic.ts';
import type { RtcRttRefinementGate } from './rtc-topology/topic/rtc-rtt-refinement-gate.ts';
import type { RtcRttRefinementService } from './rtc-topology/topic/rtc-rtt-refinement-service.ts';
// prettier-ignore
import type {
  GroupLifecyclePolicyRead,
} from './group-state/persistence/group-lifecycle-policy-repository.ts';
// prettier-ignore
import type {
  GroupMutationCommand,
} from './group-state/mutation/group-mutation-contracts.ts';
// prettier-ignore
import {
  createFormationTimerWorkHandler,
} from './topology/replay/create-formation-timer-work-handler.ts';
import { AppOutboxType } from './services/AppOutboxService.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

// Two rebuilds per five seconds. The RTT rebuild debounce defaults to 250 ms,
// so an uncapped sustained stream permits four per second of synchronous
// all-pairs work over every active session; the cached graph is read by the
// graph diagnostics surface, which does not need that freshness.
const DEFAULT_GLOBAL_GRAPH_RECOMPUTE_LIMIT = { windowMs: 5_000, maxPerWindow: 2 } as const;

export type InitRallarSystemWsTopicsOptions = Readonly<{
  initDynamicTopics?: boolean;
  dynamicTopicRouterOptions?: DynamicWsTopicRouterOptions;
  rtcTopologyService?: RallarRtcTopologyService;
  rtcTopologyOptions?: RallarRtcTopologyServiceOptions;
  rtcTopologyManagement?: GroupTopologyManagementService;
  rttRefinementGate?: RtcRttRefinementGate;
  rttRefinementService?: RtcRttRefinementService;
  observeGroupSnapshot?: (snapshot: GroupSnapshot) => void | Promise<void>;
  observeClientSnapshot?: (snapshot: ClientSnapshot) => void | Promise<void>;
  rtcTopologyRuntimeState?: Readonly<{
    repository: RuntimeStateRepositoryLike;
    rttTtlMs?: number;
  }>;
  rtcTopologyRepositories?: RtcTopologyRuntimeState;
  globalGraphRecomputeLimit?: Readonly<{
    windowMs: number;
    maxPerWindow: number;
  }>;
  rtcTopologyAppOutbox?: Readonly<{
    database: PSqlSql;
    outboxQueueReader: OutboxQueueReader;
    topicId?: string;
    senderId?: string;
    wake?: () => void;
    wakeReplay?: () => void;
    findGroupSnapshotByRef?: GroupTopologyGroupSnapshotReader;
    executionRepository: RtcTopologyExecutionRepository;
    topologyDelivery?: RtcTopologyDeliveryOptions;
    formationCriterion?: Readonly<{
      readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
      submitCommand: (command: GroupMutationCommand, atEpochMs: number) => Promise<void>;
    }>;
  }>;
  enqueueRtcRttMutation?: (
    input: Readonly<{
      rtt: RttMeasurementInfo;
      alSenderId: string;
      capturedAtEpochMs: number;
    }>,
  ) => Promise<ResourceEntry>;
}>;

export type RallarSystemWsTopicsRuntime = Readonly<{
  rtcTopologyWorkPublisher: RtcTopologyWorkPublisher | null;
  stop(): void;
}>;

type RtcTopologyFlushTimer = ReturnType<typeof setTimeout>;

export function initRallarSystemWsTopics(
  wsQBoxServerService: WsQueueBoxServerService,
  options: InitRallarSystemWsTopicsOptions = {},
): RallarSystemWsTopicsRuntime {
  const rtcTopologyService =
    options.rtcTopologyService ?? new RallarRtcTopologyService(options.rtcTopologyOptions);
  const rtcTopologyPersistence = resolveRtcTopologyPersistence(options);
  const rtcTopologyRuntimeState = rtcTopologyPersistence.repositories;
  const rtcTopologyFlushTimers = new Map<string, RtcTopologyFlushTimer>();
  let globalGraphRttRecomputeTimer: ReturnType<typeof setTimeout> | undefined;
  const globalGraphRecomputeLimit = options.globalGraphRecomputeLimit ??
    DEFAULT_GLOBAL_GRAPH_RECOMPUTE_LIMIT;
  const globalGraphRecomputeLimiter = toRateLimiter(
    globalGraphRecomputeLimit.windowMs,
    globalGraphRecomputeLimit.maxPerWindow,
  );

  const armGlobalGraphRttRecompute = (delayMs: number): void => {
    if (globalGraphRttRecomputeTimer) {
      return;
    }
    globalGraphRttRecomputeTimer = setTimeout(() => {
      globalGraphRttRecomputeTimer = undefined;
      runGlobalGraphRttRecompute();
    }, delayMs);
    (globalGraphRttRecomputeTimer as { unref?: () => void }).unref?.();
  };

  // The debounce only coalesces a burst; a sustained RTT stream still rebuilds
  // every debounce window forever, and the rebuild is synchronous all-pairs
  // work over every active session on the server. The rate limiter caps how
  // often that can happen. A denied attempt re-arms rather than dropping, so
  // the last update in a quiescing group still reaches the cache.
  const runGlobalGraphRttRecompute = (): void => {
    if (!globalGraphRecomputeLimiter.allow()) {
      armGlobalGraphRttRecompute(globalGraphRecomputeLimit.windowMs);
      return;
    }
    computeGlobalGraphAndCacheItIfPossible(rtcTopologyService.readRttReportingDegreeLimit());
  };

  const scheduleGlobalGraphRttRecompute = (): void => {
    const delayMs = rtcTopologyService.readRttRebuildDebounceMs();
    if (delayMs === 0) {
      runGlobalGraphRttRecompute();
      return;
    }
    armGlobalGraphRttRecompute(delayMs);
  };
  const rtcTopologyAppOutboxOptions = options.rtcTopologyAppOutbox;
  const findGroupSnapshotByRef =
    rtcTopologyAppOutboxOptions?.findGroupSnapshotByRef ??
    ((ref: GroupRef) => groupStateSnapshotsRepository.findGroupStateSnapshotByRef(ref));
  const rtcTopologyManagement = options.rtcTopologyManagement;
  const rtcTopologyAppOutbox = rtcTopologyAppOutboxOptions
    ? createRtcTopologyOutboxPublisher({
        outboxQueueReader: rtcTopologyAppOutboxOptions.outboxQueueReader,
        senderId: rtcTopologyAppOutboxOptions.senderId ?? wsQBoxServerService.name,
        topicId: rtcTopologyAppOutboxOptions.topicId,
        wake: rtcTopologyAppOutboxOptions.wake,
        now: options.rtcTopologyOptions?.now,
      })
    : undefined;
  if (rtcTopologyAppOutbox && rtcTopologyAppOutboxOptions) {
    if (!rtcTopologyManagement) {
      throw new TypeError('RTC topology AppOutbox requires topology management');
    }
    if (rtcTopologyAppOutboxOptions.formationCriterion) {
      rtcTopologyAppOutboxOptions.outboxQueueReader.onOutboxMessageDo(
        AppOutboxType.FORMATION_TIMER,
        createFormationTimerWorkHandler({
          findGroupSnapshotByRef: async (ref) => await findGroupSnapshotByRef(ref),
          readPlannedTopology: async (ref) => {
            const view = (await rtcTopologyManagement.readTopologyView(ref)) as Readonly<{
              snapshot: RallarOverlayTopologySnapshot | null;
            }>;
            return view.snapshot;
          },
          topologyPlanning: rtcTopologyManagement.planningService,
          readLifecyclePolicy: rtcTopologyAppOutboxOptions.formationCriterion.readLifecyclePolicy,
          submitCommand: rtcTopologyAppOutboxOptions.formationCriterion.submitCommand,
          nowEpochMs: options.rtcTopologyOptions?.now ?? (() => Date.now()),
        }),
      );
    }
    rtcTopologyAppOutboxOptions.outboxQueueReader.onOutboxMessageDo(
      rtcTopologyAppOutbox.workType,
      createRtcTopologyWorkHandler({
        runtime: rtcTopologyAppOutbox,
        database: rtcTopologyAppOutboxOptions.database,
        topologyPlanning: rtcTopologyManagement.planningService,
        executionRepository: rtcTopologyAppOutboxOptions.executionRepository,
        rttRefinementService: options.rttRefinementService,
        topologyDelivery: rtcTopologyAppOutboxOptions.topologyDelivery,
        formationCriterion: rtcTopologyAppOutboxOptions.formationCriterion,
        wakeQueue: rtcTopologyAppOutboxOptions.wake,
        wakeReplay: rtcTopologyAppOutboxOptions.wakeReplay,
        onInactiveOverlay: (overlayId) =>
          clearRtcTopologyFlushTimer(overlayId, rtcTopologyFlushTimers),
      }),
    );
  }

  initStateBroadcastTopic(AppTopics.clientStateSnapshot, wsQBoxServerService, (rawData) => {
    const data = rawData as ClientSnapshot;
    if (options.observeClientSnapshot) {
      return options.observeClientSnapshot(data);
    } else {
      clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId(
        data.principal.principalId,
        data,
      );
    }
  });
  initStateBroadcastTopic(AppTopics.clientStateEvent, wsQBoxServerService);
  initStateBroadcastTopic(AppTopics.groupStateSnapshot, wsQBoxServerService, (rawData) => {
    const data = rawData as GroupSnapshot;
    if (options.observeGroupSnapshot) {
      return options.observeGroupSnapshot(data);
    } else {
      groupStateSnapshotsRepository.setGroupStateSnapshot(data);
    }
  });
  initStateBroadcastTopic(AppTopics.groupDirectorySnapshot, wsQBoxServerService, (rawData) => {
    const data = rawData as GroupSnapshot;
    if (options.observeGroupSnapshot) {
      return options.observeGroupSnapshot(data);
    } else {
      groupStateSnapshotsRepository.setGroupStateSnapshot(data);
    }
  });
  initStateBroadcastTopic(AppTopics.groupStateEvent, wsQBoxServerService);
  initGraphsTopic(wsQBoxServerService);
  initOverlayTopologyTopic(wsQBoxServerService);
  initChatTopic(wsQBoxServerService);
  initRtcRttTopic({
    wsQueueBoxServerService: wsQBoxServerService,
    rtcTopologyService,
    rtcTopologyWorkPublisher: rtcTopologyAppOutbox?.publisher,
    runtimeState: rtcTopologyRuntimeState,
    persistentRuntimeDeclared: rtcTopologyPersistence.declared,
    rttRefinementGate: options.rttRefinementGate,
    scheduleGlobalGraphRttRecompute,
    findGroupSnapshotByRef,
    enqueueRtcRttMutation: options.enqueueRtcRttMutation,
  });
  initRtcSignalingTopic(wsQBoxServerService);
  if (options.initDynamicTopics ?? true) {
    initDynamicWsTopicRouter(wsQBoxServerService, options.dynamicTopicRouterOptions);
  }
  return {
    rtcTopologyWorkPublisher: rtcTopologyAppOutbox?.publisher ?? null,
    stop: () => {
      if (globalGraphRttRecomputeTimer !== undefined) {
        clearTimeout(globalGraphRttRecomputeTimer);
        globalGraphRttRecomputeTimer = undefined;
      }
      for (const timer of rtcTopologyFlushTimers.values()) {
        clearTimeout(timer);
      }
      rtcTopologyFlushTimers.clear();
    },
  };
}

function initStateBroadcastTopic(
  topicId: string,
  wsQBoxServerService: WsQueueBoxServerService,
  onState?: (
    data: unknown,
    message: ALMessage,
    server: JsonWebSocketServer,
  ) => void | Promise<void>,
  afterInbox?: (
    data: unknown,
    message: ALMessage,
    server: JsonWebSocketServer,
  ) => void | Promise<void>,
  afterOutbox?: (
    data: unknown,
    message: ALMessage,
    server: JsonWebSocketServer,
  ) => void | Promise<void>,
): void {
  const readState = (data: ALMessage): unknown => {
    return JSON.parse(data.payload.resource);
  };

  wsQBoxServerService.onInboxMessageDo(topicId, {
    onMessage: async (data: ALMessage, _: ResourceEntry, server: JsonWebSocketServer) => {
      if (!isTopic(data, topicId)) {
        return;
      }

      const state = readState(data);
      await onState?.(state, data, server);
      sendStateSyncMessage(server, data);
      await afterInbox?.(state, data, server);
    },
  });

  wsQBoxServerService.onOutboxMessageDo(topicId, {
    onMessage: async (data: ALMessage, _: ResourceEntry, server: JsonWebSocketServer) => {
      if (!isTopic(data, topicId)) {
        return;
      }

      const state = readState(data);
      await onState?.(state, data, server);
      sendStateSyncMessage(server, data);
      await afterOutbox?.(state, data, server);
    },
  });
}

function initGraphsTopic(wsQBoxServerService: WsQueueBoxServerService): void {
  wsQBoxServerService.onInboxMessageDo(AppTopics.graphs, {
    onMessage: (data: ALMessage, _: ResourceEntry, server: JsonWebSocketServer) => {
      if (!isTopic(data, AppTopics.graphs)) {
        return Promise.resolve();
      }

      server.broadcast(data);
      return Promise.resolve();
    },
  });

  wsQBoxServerService.onOutboxMessageDo(AppTopics.graphs, {
    onMessage: (data: ALMessage, _: ResourceEntry, server: JsonWebSocketServer) => {
      if (!isTopic(data, AppTopics.graphs)) {
        return Promise.resolve();
      }

      server.broadcast(data);
      return Promise.resolve();
    },
  });
}

function initOverlayTopologyTopic(wsQBoxServerService: WsQueueBoxServerService): void {
  wsQBoxServerService.onInboxMessageDo(AppTopics.overlayTopology, {
    onMessage: (data: ALMessage, _: ResourceEntry, server: JsonWebSocketServer) => {
      if (!isTopic(data, AppTopics.overlayTopology)) {
        return Promise.resolve();
      }

      sendStateSyncMessage(server, data);
      return Promise.resolve();
    },
  });

  wsQBoxServerService.onOutboxMessageDo(AppTopics.overlayTopology, {
    onMessage: (data: ALMessage, _: ResourceEntry, server: JsonWebSocketServer) => {
      if (!isTopic(data, AppTopics.overlayTopology)) {
        return Promise.resolve();
      }

      sendStateSyncMessage(server, data);
      return Promise.resolve();
    },
  });
}

function clearRtcTopologyFlushTimer(
  overlayId: string,
  rtcTopologyFlushTimers: Map<string, RtcTopologyFlushTimer>,
): void {
  const timer = rtcTopologyFlushTimers.get(overlayId);
  if (timer) {
    clearTimeout(timer);
    rtcTopologyFlushTimers.delete(overlayId);
  }
}

function initChatTopic(wsQBoxServerService: WsQueueBoxServerService): void {
  wsQBoxServerService.onInboxMessageDo(AppTopics.chat, {
    onMessage: (data: ALMessage, _: ResourceEntry, server: JsonWebSocketServer) => {
      if (!isTopic(data, AppTopics.chat)) {
        return Promise.resolve();
      }

      server.broadcast(data);
      return Promise.resolve();
    },
  });
}

function resolveRtcTopologyPersistence(options: InitRallarSystemWsTopicsOptions): Readonly<{
  declared: boolean;
  repositories: RtcTopologyRuntimeState | undefined;
}> {
  if (options.rtcTopologyRuntimeState && options.rtcTopologyRepositories) {
    throw new TypeError('Conflicting RTC topology runtime declarations');
  }
  return {
    declared:
      options.rtcTopologyRuntimeState !== undefined ||
      options.rtcTopologyRepositories !== undefined,
    repositories: options.rtcTopologyRepositories,
  };
}

function initRtcSignalingTopic(wsQBoxServerService: WsQueueBoxServerService): void {
  wsQBoxServerService.onInboxMessageDo(AppTopics.rtcSignaling, {
    onMessage: (data: ALMessage, _: ResourceEntry, server: JsonWebSocketServer) => {
      if (!isTopic(data, AppTopics.rtcSignaling)) {
        return Promise.resolve();
      }

      const msg: QRtcSignalingMessage = JSON.parse(data.payload.resource) as QRtcSignalingMessage;
      if (msg === undefined) {
        return Promise.reject('Invalid signaling message:');
      }

      console.log(`Received signaling message: ${JSON.stringify(msg)}`);

      server.send(msg.toId, data);

      return Promise.resolve();
    },
  });
}

function isTopic(message: ALMessage, topicId: string): boolean {
  return message.route.topicId === topicId;
}
