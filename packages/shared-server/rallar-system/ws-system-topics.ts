import { AppTopics, type RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { toScopedOverlayId, toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import {
    type ALMessage,
    readALTargetGroupRef,
} from '@shared/al-contracts/al-contract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import * as rttRepository from '@shared/repository/rtt-repository.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { QRtcSignalingMessage } from '@shared/webrtc/QRtcSignalingContracts.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { computeGlobalGraphAndCacheIt } from '@shared-graph/group-graphs-create-service.ts';
import * as vivaldiService from '@shared-graph/vivaldi-service.ts';
import { type DynamicWsTopicRouterOptions, initDynamicWsTopicRouter, } from '../rallar-facade/ws-topic-router.ts';
import { sendStateSyncMessage } from './state-sync-routing.ts';
import {
    createRtcTopologyOutboxPublisher,
    createRtcTopologyWorkHandler,
    drainRtcRttRecomputeOutbox,
    type RtcTopologyWorkPublisher,
} from './services/RtcTopologyOutboxWork.ts';
import {
    RallarRtcTopologyService,
    type RallarRtcTopologyServiceOptions,
} from './services/rallar-rtc-topology-service.ts';
import {
    GroupTopologyManagementService,
    type GroupTopologyGroupSnapshotReader,
} from './services/group-topology-management-service.ts';
import {
    evaluateRtcRttMeasurement,
    type RtcRttAcceptanceResult,
} from './services/rtc-rtt-measurement-policy.ts';
import { executeRttMutation } from './services/rtc-rtt-mutation-service.ts';
import { GroupTopologyConfigRepository } from './repositories/GroupTopologyConfigRepository.ts';
import { GroupStateRepository } from './repositories/GroupStateRepository.ts';
import { RtcRttRepository, type RtcRttRepositoryOptions, } from './repositories/RtcRttRepository.ts';
import { RtcTopologySnapshotRepository } from './repositories/RtcTopologySnapshotRepository.ts';
import {
    isRuntimeStateConditionalRepositoryLike,
    isRuntimeStateOptimisticTransactionalRepositoryLike,
    isRuntimeStateTransactionalRepositoryLike,
    type RuntimeStateRepositoryLike,
} from '../runtime-state/RuntimeStateRepository.ts';
import type { RtcTopologyPublicationFanout } from './pubsub/RtcTopologyClusterTransport.ts';
import type { RtcTopologyExecutionRepository } from './repositories/RtcTopologyExecutionRepository.ts';

export type InitRallarSystemWsTopicsOptions = Readonly<{
    initDynamicTopics?: boolean;
    dynamicTopicRouterOptions?: DynamicWsTopicRouterOptions;
    rtcTopologyService?: RallarRtcTopologyService;
    rtcTopologyOptions?: RallarRtcTopologyServiceOptions;
    rtcTopologyManagement?: GroupTopologyManagementService;
    observeGroupSnapshot?: (snapshot: GroupSnapshot) => void | Promise<void>;
    observeClientSnapshot?: (snapshot: ClientSnapshot) => void | Promise<void>;
    rtcTopologyRuntimeState?: Readonly<{
        repository: RuntimeStateRepositoryLike;
        rttTtlMs?: number;
    }>;
    rtcTopologyRepositories?: RtcTopologyRuntimeState;
    rtcTopologyAppOutbox?: Readonly<{
        outboxQueueReader: OutboxQueueReader;
        topicId?: string;
        senderId?: string;
        wake?: () => void;
        findGroupSnapshotByRef?: GroupTopologyGroupSnapshotReader;
        executionRepository: RtcTopologyExecutionRepository;
        publicationFanout: RtcTopologyPublicationFanout;
    }>;
}>;

export type RallarSystemWsTopicsRuntime = Readonly<{
    rtcTopologyWorkPublisher: RtcTopologyWorkPublisher | null;
}>;

type RtcTopologyFlushTimer = ReturnType<typeof setTimeout>;

type RtcTopologyRuntimeState = Readonly<{
    topologyConfig: GroupTopologyConfigRepository;
    groupState?: GroupStateRepository;
    topologySnapshots: RtcTopologySnapshotRepository;
    rtts: RtcRttRepository;
}>;

export function initRallarSystemWsTopics(
    wsQBoxServerService: WsQueueBoxServerService,
    options: InitRallarSystemWsTopicsOptions = {},
): RallarSystemWsTopicsRuntime {
    const rtcTopologyService = options.rtcTopologyService ??
        new RallarRtcTopologyService(
            options.rtcTopologyOptions,
        );
    const rtcTopologyRuntimeState = options.rtcTopologyRepositories ??
        (options.rtcTopologyRuntimeState
        ? createRtcTopologyRuntimeState(
            options.rtcTopologyRuntimeState.repository,
            {
                ttlMs: options.rtcTopologyRuntimeState.rttTtlMs,
                now: options.rtcTopologyOptions?.now,
            },
        )
        : undefined);
    const rtcTopologyFlushTimers = new Map<string, RtcTopologyFlushTimer>();
    let globalGraphRttRecomputeTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleGlobalGraphRttRecompute = (): void => {
        const delayMs = rtcTopologyService.readRttRebuildDebounceMs();
        const recompute = (): void => {
            computeGlobalGraphAndCacheItIfPossible(
                rtcTopologyService.readRttReportingDegreeLimit(),
            );
        };

        if (delayMs === 0) {
            recompute();
            return;
        }

        if (globalGraphRttRecomputeTimer) {
            return;
        }

        globalGraphRttRecomputeTimer = setTimeout(() => {
            globalGraphRttRecomputeTimer = undefined;
            recompute();
        }, delayMs);
        (globalGraphRttRecomputeTimer as { unref?: () => void }).unref?.();
    };
    const rtcTopologyAppOutboxOptions = options.rtcTopologyAppOutbox;
    const findGroupSnapshotByRef =
        rtcTopologyAppOutboxOptions?.findGroupSnapshotByRef ??
        ((ref: GroupRef) =>
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(ref));
    const rtcTopologyManagement = options.rtcTopologyManagement ??
        new GroupTopologyManagementService({
        findGroupSnapshotByRef,
        groupStateRepository: rtcTopologyRuntimeState?.groupState,
        configRepository: rtcTopologyRuntimeState?.topologyConfig,
        topologyService: rtcTopologyService,
        topologySnapshotRepository: rtcTopologyRuntimeState?.topologySnapshots,
        rttRepository: rtcTopologyRuntimeState?.rtts,
        processRttReader: () => rttRepository.getAllRtt(),
        serverDefaults: {
            ...options.rtcTopologyOptions,
            topologyKind: options.rtcTopologyOptions?.topologyKind ?? 'auto',
        },
        now: options.rtcTopologyOptions?.now,
        });
    const rtcTopologyAppOutbox = rtcTopologyAppOutboxOptions
        ? createRtcTopologyOutboxPublisher({
            outboxQueueReader: rtcTopologyAppOutboxOptions.outboxQueueReader,
            senderId: rtcTopologyAppOutboxOptions.senderId ??
                wsQBoxServerService.name,
            topicId: rtcTopologyAppOutboxOptions.topicId,
            wake: rtcTopologyAppOutboxOptions.wake,
            now: options.rtcTopologyOptions?.now,
        })
        : undefined;

    if (rtcTopologyAppOutbox && rtcTopologyAppOutboxOptions) {
        rtcTopologyAppOutboxOptions.outboxQueueReader.onOutboxMessageDo(
            rtcTopologyAppOutbox.workType,
            createRtcTopologyWorkHandler({
                runtime: rtcTopologyAppOutbox,
                topologyManagement: rtcTopologyManagement,
                executionRepository:
                    rtcTopologyAppOutboxOptions.executionRepository,
                publicationFanout: rtcTopologyAppOutboxOptions.publicationFanout,
                onInactiveOverlay: (overlayId) =>
                    clearRtcTopologyFlushTimer(
                        overlayId,
                        rtcTopologyFlushTimers,
                    ),
            }),
        );
        if (rtcTopologyRuntimeState) {
            void drainRtcRttRecomputeOutbox({
                repository: rtcTopologyRuntimeState.rtts,
                publisher: rtcTopologyAppOutbox.publisher,
                debounceMs: rtcTopologyService.readRttRebuildDebounceMs(),
            }).catch((error) => {
                console.warn('RTC RTT recompute outbox startup drain failed', error);
            });
        }
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
    const handleGroupStateSnapshot = async (
        rawData: unknown,
        _message: ALMessage,
        server: JsonWebSocketServer,
    ): Promise<void> => {
        const data = rawData as GroupSnapshot;
        if (rtcTopologyAppOutbox) {
            await rtcTopologyAppOutbox.publisher.enqueueForGroupSnapshot(data);
            return;
        }

        if (data.group.status !== 'active') {
            await removeRtcOverlayTopology(
                data,
                rtcTopologyManagement,
                rtcTopologyFlushTimers,
            );
            return;
        }

        await publishRtcOverlayTopology(data, server, rtcTopologyManagement);
    };
    initStateBroadcastTopic(
        AppTopics.groupStateSnapshot,
        wsQBoxServerService,
        (rawData) => {
            const data = rawData as GroupSnapshot;
            if (options.observeGroupSnapshot) {
                return options.observeGroupSnapshot(data);
            } else {
                groupStateSnapshotsRepository.setGroupStateSnapshot(data);
            }
        },
        rtcTopologyAppOutbox ? undefined : handleGroupStateSnapshot,
        rtcTopologyAppOutbox ? undefined : handleGroupStateSnapshot,
    );
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
    initRttTopic(
        wsQBoxServerService,
        rtcTopologyService,
        rtcTopologyFlushTimers,
        rtcTopologyAppOutbox?.publisher,
        rtcTopologyManagement,
        rtcTopologyRuntimeState,
        scheduleGlobalGraphRttRecompute,
        findGroupSnapshotByRef,
    );
    initRtcSignalingTopic(wsQBoxServerService);
    if (options.initDynamicTopics ?? true) {
        initDynamicWsTopicRouter(wsQBoxServerService, options.dynamicTopicRouterOptions);
    }
    return {
        rtcTopologyWorkPublisher: rtcTopologyAppOutbox?.publisher ?? null,
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

function createRtcTopologyRuntimeState(
    repository: RuntimeStateRepositoryLike,
    rttOptions: RtcRttRepositoryOptions,
): RtcTopologyRuntimeState {
    return {
        topologyConfig: new GroupTopologyConfigRepository(repository),
        groupState: new GroupStateRepository(repository),
        topologySnapshots: new RtcTopologySnapshotRepository(repository),
        rtts: new RtcRttRepository(repository, rttOptions),
    };
}

async function publishRtcOverlayTopology(
    group: GroupSnapshot,
    server: JsonWebSocketServer,
    topologyManagement: GroupTopologyManagementService,
): Promise<void> {
    await topologyManagement.reconfigureGroupTopology({
        groupRef: group.group,
        groupSnapshot: group,
        publisher: (message) => {
            sendStateSyncMessage(server, message);
        },
    });
}

async function publishDueRtcOverlayTopology(
    group: GroupSnapshot,
    server: JsonWebSocketServer,
    topologyManagement: GroupTopologyManagementService,
): Promise<boolean> {
    const result = await topologyManagement.flushDueGroupTopology({
        groupRef: group.group,
        groupSnapshot: group,
        publisher: (message) => {
            sendStateSyncMessage(server, message);
        },
    });

    if (!result) {
        return false;
    }
    return result.changed;
}

async function removeRtcOverlayTopology(
    group: GroupSnapshot,
    topologyManagement: GroupTopologyManagementService,
    rtcTopologyFlushTimers: Map<string, RtcTopologyFlushTimer>,
): Promise<void> {
    const overlayId = toScopedOverlayId(group.group);
    clearRtcTopologyFlushTimer(overlayId, rtcTopologyFlushTimers);

    await topologyManagement.removeGroupTopology(group);
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

function scheduleRtcOverlayTopologyFlush(
    group: GroupSnapshot,
    server: JsonWebSocketServer,
    rtcTopologyService: RallarRtcTopologyService,
    rtcTopologyFlushTimers: Map<string, RtcTopologyFlushTimer>,
    topologyManagement: GroupTopologyManagementService,
): void {
    const queued = rtcTopologyService.queueRttTopologyUpdate(group);

    if (queued.immediate) {
        void publishDueRtcOverlayTopology(
            group,
            server,
            topologyManagement,
        );
        return;
    }

    if (!queued.newlyQueued && rtcTopologyFlushTimers.has(queued.overlayId)) {
        return;
    }

    const timer = setTimeout(() => {
        void (async () => {
            rtcTopologyFlushTimers.delete(queued.overlayId);
            const latestGroup = groupStateSnapshotsRepository.findGroupStateSnapshotByRef(
                group.group,
            ) ?? group;
            await publishDueRtcOverlayTopology(
                latestGroup,
                server,
                topologyManagement,
            );

            if (
                rtcTopologyService.readRttTopologyUpdateDelayMs(latestGroup) !==
                undefined
            ) {
                scheduleRtcOverlayTopologyFlush(
                    latestGroup,
                    server,
                    rtcTopologyService,
                    rtcTopologyFlushTimers,
                    topologyManagement,
                );
            }
        })();
    }, queued.delayMs);

    rtcTopologyFlushTimers.set(queued.overlayId, timer);
}

function scheduleRtcOverlayTopologyFlushesForRtt(
    groups: readonly GroupSnapshot[],
    server: JsonWebSocketServer,
    rtcTopologyService: RallarRtcTopologyService,
    rtcTopologyFlushTimers: Map<string, RtcTopologyFlushTimer>,
    topologyManagement: GroupTopologyManagementService,
): void {
    for (const group of groups) {
        scheduleRtcOverlayTopologyFlush(
            group,
            server,
            rtcTopologyService,
            rtcTopologyFlushTimers,
            topologyManagement,
        );
    }
}

async function findGroupsAffectedByRtt(
    rtt: RttMeasurementInfo,
    message: ALMessage,
    findGroupSnapshotByRef?: GroupTopologyGroupSnapshotReader,
): Promise<readonly GroupSnapshot[]> {
    const groupRef = readALTargetGroupRef(message);
    if (groupRef && findGroupSnapshotByRef) {
        const snapshot = await findGroupSnapshotByRef(groupRef);
        return snapshot ? [snapshot] : [];
    }

    return groupStateSnapshotsRepository.findGroupStateSnapshotsBySessionIds([
        rtt.sessionIdFrom,
        rtt.sessionIdTo,
    ]);
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

function initRttTopic(
    wsQBoxServerService: WsQueueBoxServerService,
    rtcTopologyService: RallarRtcTopologyService,
    rtcTopologyFlushTimers: Map<string, RtcTopologyFlushTimer>,
    rtcTopologyWorkPublisher?: RtcTopologyWorkPublisher,
    topologyManagement?: GroupTopologyManagementService,
    runtimeState?: RtcTopologyRuntimeState,
    scheduleGlobalGraphRttRecompute: () => void = () => {
    },
    findGroupSnapshotByRef?: GroupTopologyGroupSnapshotReader,
): void {
    wsQBoxServerService.onInboxMessageDo(AppTopics.rtt, {
        onMessage: async (data: ALMessage, _: ResourceEntry, server: JsonWebSocketServer) => {
            if (!isTopic(data, AppTopics.rtt)) {
                return;
            }

            const rtt: RttMeasurementInfo = JSON.parse(data.payload.resource) as RttMeasurementInfo;

            console.log(`Received RTT message: ${data.payload.resource}`);

            const readPolicyInputs = async () => {
                const candidateGroups = await findGroupsAffectedByRtt(
                    rtt,
                    data,
                    findGroupSnapshotByRef,
                );
                return {
                    candidateGroups,
                    overlaySnapshotsByGroupKey: await readOverlaySnapshotsForGroups(
                        candidateGroups,
                        rtcTopologyService,
                        runtimeState,
                    ),
                    degreeLimit: rtcTopologyService.readRttReportingDegreeLimit(),
                };
            };
            const acceptance = await acceptRtcRttMeasurementWithPolicy({
                rtt,
                alSenderId: data.id.senderId,
                readPolicyInputs,
                runtimeState,
            });
            if (!acceptance.accepted) {
                console.warn(`Rejected RTC RTT measurement: ${acceptance.reason}`);
                return;
            }
            if (!acceptance.updated) {
                return;
            }

            vivaldiService.observeRtt(rtt);
            scheduleGlobalGraphRttRecompute();
            if (rtcTopologyWorkPublisher) {
                if (runtimeState) {
                    await drainRtcRttRecomputeOutbox({
                        repository: runtimeState.rtts,
                        publisher: rtcTopologyWorkPublisher,
                        debounceMs: rtcTopologyService.readRttRebuildDebounceMs(),
                    });
                } else {
                    await rtcTopologyWorkPublisher.enqueueForRttGroups(
                        rtt,
                        acceptance.affectedGroups,
                        rtcTopologyService.readRttRebuildDebounceMs(),
                    );
                }
            } else {
                scheduleRtcOverlayTopologyFlushesForRtt(
                    acceptance.affectedGroups,
                    server,
                    rtcTopologyService,
                    rtcTopologyFlushTimers,
                    topologyManagement!,
                );
            }
        },
    });
}

type StoredRtcRttAcceptanceResult = RtcRttAcceptanceResult & Readonly<{
    updated: boolean;
}>;

async function acceptRtcRttMeasurementWithPolicy(input: {
    readonly rtt: RttMeasurementInfo;
    readonly alSenderId: string;
    readonly readPolicyInputs: () => Promise<Readonly<{
        candidateGroups: readonly GroupSnapshot[];
        overlaySnapshotsByGroupKey: ReadonlyMap<string, RallarOverlayTopologySnapshot>;
        degreeLimit: number;
    }>>;
    readonly runtimeState?: RtcTopologyRuntimeState;
}): Promise<StoredRtcRttAcceptanceResult> {
    const evaluate = (
        policyInputs: Readonly<{
            candidateGroups: readonly GroupSnapshot[];
            overlaySnapshotsByGroupKey: ReadonlyMap<string, RallarOverlayTopologySnapshot>;
            degreeLimit: number;
        }>,
        existingMeasurements: readonly RttMeasurementInfo[],
        requestedAtEpochMs: number,
    ): RtcRttAcceptanceResult =>
        evaluateRtcRttMeasurement({
            rtt: input.rtt,
            alSenderId: input.alSenderId,
            requestedAtEpochMs,
            ...policyInputs,
            existingMeasurements,
        });

    if (!input.runtimeState) {
        const requestedAtEpochMs = Date.now();
        const result = evaluate(
            await input.readPolicyInputs(),
            rttRepository.getAllRtt(),
            requestedAtEpochMs,
        );
        return {
            ...result,
            updated: result.accepted ? rttRepository.setRtt(input.rtt) : false,
        };
    }

    const runtimeRtts = input.runtimeState.rtts;
    const runtime = runtimeRtts.runtimeRepository;
    if (!isRuntimeStateOptimisticTransactionalRepositoryLike(runtime)) {
        throw new TypeError(
            'RTC RTT persistence requires conditional transactional runtime state',
        );
    }
    const executed = await executeRttMutation({
        repository: runtimeRtts,
        runtime,
        request: {
            rtt: input.rtt,
            alSenderId: input.alSenderId,
        },
        readCommand: async () => {
            return {
                rtt: input.rtt,
                alSenderId: input.alSenderId,
                ...await input.readPolicyInputs(),
            };
        },
        readFacts: () => runtimeRtts.readMutationFacts(),
    });
    if (executed.updated) {
        rttRepository.setRtt(input.rtt);
    }
    if (executed.computed.outcome === 'replay') {
        return {
            accepted: true,
            reason: 'accepted',
            affectedGroups: [],
            updated: false,
        };
    }
    if (executed.computed.outcome === 'rejected') {
        return executed.computed.reason === 'stale'
            ? {
                accepted: true,
                reason: 'accepted',
                affectedGroups: [],
                updated: false,
            }
            : {
                accepted: false,
                reason: executed.computed.reason,
                affectedGroups: executed.computed.affectedGroups,
                updated: false,
            };
    }
    return {
        accepted: true,
        reason: executed.computed.reason,
        affectedGroups: executed.computed.affectedGroups,
        updated: executed.updated,
    };
}

async function readOverlaySnapshotsForGroups(
    groups: readonly GroupSnapshot[],
    rtcTopologyService: RallarRtcTopologyService,
    runtimeState?: RtcTopologyRuntimeState,
): Promise<ReadonlyMap<string, RallarOverlayTopologySnapshot>> {
    const snapshots = new Map<string, RallarOverlayTopologySnapshot>();
    for (const group of groups) {
        const snapshot = runtimeState
            ? await runtimeState.topologySnapshots.findSnapshot(group.group)
            : rtcTopologyService.readSnapshot(group);
        if (snapshot) {
            snapshots.set(toWebRtcGroupKey(group.group), snapshot);
        }
    }
    return snapshots;
}

function computeGlobalGraphAndCacheItIfPossible(
    predictedDegreeLimit?: number,
): void {
    try {
        computeGlobalGraphAndCacheIt(
            predictedDegreeLimit !== undefined
                ? { predictedDegreeLimit }
                : {},
        );
    } catch (error) {
        console.warn(
            `Skipping global graph cache recompute after partial RTT update: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}

function initRtcSignalingTopic(wsQBoxServerService: WsQueueBoxServerService): void {
    wsQBoxServerService.onInboxMessageDo(AppTopics.rtcSignaling, {
        onMessage: (data: ALMessage, _: ResourceEntry, server: JsonWebSocketServer) => {
            if (!isTopic(data, AppTopics.rtcSignaling)) {
                return Promise.resolve();
            }

            const msg: QRtcSignalingMessage = JSON.parse(
                data.payload.resource,
            ) as QRtcSignalingMessage;
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
