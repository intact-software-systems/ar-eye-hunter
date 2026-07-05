import { AppTopics, type RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { type ALMessage, newALBroadcastMessage, newALRoute, } from '@shared/al-contracts/al-contract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import * as rttRepository from '@shared/repository/rtt-repository.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { QRtcSignalingMessage } from '@shared/webrtc/QRtcSignalingContracts.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { computeGlobalGraphAndCacheIt } from '@shared-graph/group-graphs-create-service.ts';
import * as vivaldiService from '@shared-graph/vivaldi-service.ts';
import { type DynamicWsTopicRouterOptions, initDynamicWsTopicRouter, } from '../rallar-facade/ws-topic-router.ts';
import { sendStateSyncMessage } from './state-sync-routing.ts';
import { AppInboxType } from './services/AppInboxService.ts';
import {
    COALESCED_APP_INBOX_WORK_FIELD,
    type CoalescedAppInboxWorkData,
    CoalescedAppInboxWorkService,
} from './services/CoalescedAppInboxWorkService.ts';
import {
    RallarRtcTopologyService,
    type RallarRtcTopologyServiceOptions,
    type RallarRtcTopologyUpdateResult,
} from './services/rallar-rtc-topology-service.ts';
import { RtcRttRepository, type RtcRttRepositoryOptions, } from './repositories/RtcRttRepository.ts';
import { RtcTopologySnapshotRepository } from './repositories/RtcTopologySnapshotRepository.ts';
import type { RuntimeStateRepositoryLike } from '../runtime-state/RuntimeStateRepository.ts';

const RTC_TOPOLOGY_APP_INBOX_TOPIC = 'app-inbox.rtc-topology';

export type InitRallarSystemWsTopicsOptions = Readonly<{
    initDynamicTopics?: boolean;
    dynamicTopicRouterOptions?: DynamicWsTopicRouterOptions;
    rtcTopologyService?: RallarRtcTopologyService;
    rtcTopologyOptions?: RallarRtcTopologyServiceOptions;
    rtcTopologyRuntimeState?: Readonly<{
        repository: RuntimeStateRepositoryLike;
        rttTtlMs?: number;
    }>;
    rtcTopologyAppInbox?: Readonly<{
        inboxQueueReader: InboxQueueReader;
        topicId?: string;
        senderId?: string;
        wake?: () => void;
        findGroupSnapshotByRef?: RtcTopologyGroupSnapshotResolver;
    }>;
}>;

type RtcTopologyFlushTimer = ReturnType<typeof setTimeout>;

type RtcTopologyGroupSnapshotResolver = (
    ref: GroupRef,
    options?: Readonly<{ minSnapshotVersion?: number }>,
) => GroupSnapshot | undefined | Promise<GroupSnapshot | undefined>;

type RtcTopologyAppInboxRuntime = Readonly<{
    service: CoalescedAppInboxWorkService;
    topicId: string;
    wake?: () => void;
    findGroupSnapshotByRef: RtcTopologyGroupSnapshotResolver;
    runtimeState?: RtcTopologyRuntimeState;
}>;

type RtcTopologyRecomputeWork = Readonly<{
    overlayId: string;
    groupRef: GroupRef;
    minGroupSnapshotVersion: number;
    minRttVersion?: number;
}>;

type RtcTopologyRuntimeState = Readonly<{
    topologySnapshots: RtcTopologySnapshotRepository;
    rtts: RtcRttRepository;
}>;

export function initRallarSystemWsTopics(
    wsQBoxServerService: WsQueueBoxServerService,
    options: InitRallarSystemWsTopicsOptions = {},
): void {
    const rtcTopologyService = options.rtcTopologyService ??
        new RallarRtcTopologyService(
            options.rtcTopologyOptions,
        );
    const rtcTopologyRuntimeState = options.rtcTopologyRuntimeState
        ? createRtcTopologyRuntimeState(
            options.rtcTopologyRuntimeState.repository,
            {
                ttlMs: options.rtcTopologyRuntimeState.rttTtlMs,
                now: options.rtcTopologyOptions?.now,
            },
        )
        : undefined;
    const rtcTopologyFlushTimers = new Map<string, RtcTopologyFlushTimer>();
    const rtcTopologyAppInboxOptions = options.rtcTopologyAppInbox;
    const rtcTopologyAppInbox = rtcTopologyAppInboxOptions
        ? {
            service: new CoalescedAppInboxWorkService(
                rtcTopologyAppInboxOptions.inboxQueueReader,
                rtcTopologyAppInboxOptions.senderId ?? wsQBoxServerService.name,
            ),
            topicId: rtcTopologyAppInboxOptions.topicId ??
                RTC_TOPOLOGY_APP_INBOX_TOPIC,
            wake: rtcTopologyAppInboxOptions.wake,
            findGroupSnapshotByRef:
                rtcTopologyAppInboxOptions.findGroupSnapshotByRef ??
                ((ref) =>
                    groupStateSnapshotsRepository.findGroupStateSnapshotByRef(
                        ref,
                    )),
            runtimeState: rtcTopologyRuntimeState,
        }
        : undefined;

    if (rtcTopologyAppInbox && rtcTopologyAppInboxOptions) {
        initRtcTopologyAppInboxTopic(
            rtcTopologyAppInboxOptions.inboxQueueReader,
            wsQBoxServerService,
            rtcTopologyService,
            rtcTopologyAppInbox,
        );
    }

    initStateBroadcastTopic(AppTopics.clientStateSnapshot, wsQBoxServerService, (rawData) => {
        const data = rawData as ClientSnapshot;
        clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId(
            data.principal.principalId,
            data,
        );
    });
    initStateBroadcastTopic(AppTopics.clientStateEvent, wsQBoxServerService);
    initStateBroadcastTopic(AppTopics.groupStateSnapshot, wsQBoxServerService, (rawData) => {
        const data = rawData as GroupSnapshot;
        groupStateSnapshotsRepository.setGroupStateSnapshot(data);
    }, async (rawData, _message, server) => {
        const data = rawData as GroupSnapshot;
        if (data.group.status !== 'active') {
            await removeRtcOverlayTopology(
                data,
                rtcTopologyService,
                rtcTopologyFlushTimers,
                rtcTopologyRuntimeState,
            );
            return;
        }

        if (rtcTopologyAppInbox) {
            await enqueueRtcTopologyAppInboxWorkForGroupSnapshot(
                data,
                rtcTopologyAppInbox,
            );
        } else {
            await publishRtcOverlayTopology(
                data,
                server,
                rtcTopologyService,
                rtcTopologyRuntimeState,
            );
        }
    });
    initStateBroadcastTopic(AppTopics.groupDirectorySnapshot, wsQBoxServerService, (rawData) => {
        const data = rawData as GroupSnapshot;
        groupStateSnapshotsRepository.setGroupStateSnapshot(data);
    });
    initStateBroadcastTopic(AppTopics.groupStateEvent, wsQBoxServerService);
    initGraphsTopic(wsQBoxServerService);
    initOverlayTopologyTopic(wsQBoxServerService);
    initChatTopic(wsQBoxServerService);
    initRttTopic(
        wsQBoxServerService,
        rtcTopologyService,
        rtcTopologyFlushTimers,
        rtcTopologyAppInbox,
        rtcTopologyRuntimeState,
    );
    initRtcSignalingTopic(wsQBoxServerService);
    if (options.initDynamicTopics ?? true) {
        initDynamicWsTopicRouter(wsQBoxServerService, options.dynamicTopicRouterOptions);
    }
}

function initStateBroadcastTopic(
    topicId: string,
    wsQBoxServerService: WsQueueBoxServerService,
    onState?: (
        data: unknown,
        message: ALMessage,
        server: JsonWebSocketServer,
    ) => void,
    afterBroadcast?: (
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
            onState?.(state, data, server);
            sendStateSyncMessage(server, data);
            await afterBroadcast?.(state, data, server);
        },
    });

    wsQBoxServerService.onOutboxMessageDo(topicId, {
        onMessage: async (data: ALMessage, _: ResourceEntry, server: JsonWebSocketServer) => {
            if (!isTopic(data, topicId)) {
                return;
            }

            const state = readState(data);
            onState?.(state, data, server);
            sendStateSyncMessage(server, data);
            await afterBroadcast?.(state, data, server);
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
        topologySnapshots: new RtcTopologySnapshotRepository(repository),
        rtts: new RtcRttRepository(repository, rttOptions),
    };
}

async function publishRtcOverlayTopology(
    group: GroupSnapshot,
    server: JsonWebSocketServer,
    rtcTopologyService: RallarRtcTopologyService,
    runtimeState?: RtcTopologyRuntimeState,
): Promise<void> {
    const result = await updateRtcOverlayTopology(
        group,
        rtcTopologyService,
        runtimeState,
    );

    publishRtcOverlayTopologyResult(group, server, result, rtcTopologyService);
}

async function publishDueRtcOverlayTopology(
    group: GroupSnapshot,
    server: JsonWebSocketServer,
    rtcTopologyService: RallarRtcTopologyService,
    runtimeState?: RtcTopologyRuntimeState,
): Promise<boolean> {
    const rttMeasurements = await readRtcTopologyRttMeasurements(
        group,
        runtimeState,
    );
    const result = rtcTopologyService.flushDueRttTopologyUpdate(
        group,
        rttMeasurements,
    );

    if (result === undefined) {
        return false;
    }

    publishRtcOverlayTopologyResult(group, server, result, rtcTopologyService);
    return result.changed;
}

async function updateRtcOverlayTopology(
    group: GroupSnapshot,
    rtcTopologyService: RallarRtcTopologyService,
    runtimeState?: RtcTopologyRuntimeState,
): Promise<RallarRtcTopologyUpdateResult> {
    const rttMeasurements = await readRtcTopologyRttMeasurements(
        group,
        runtimeState,
    );

    if (!runtimeState) {
        return rtcTopologyService.updateGroupTopology(group, rttMeasurements);
    }

    return await runtimeState.topologySnapshots.withSnapshotLock(
        group.group,
        async (repository) => {
            const previous = await repository.findSnapshot(group.group);
            const result = rtcTopologyService.updateGroupTopology(
                group,
                rttMeasurements,
                { previous },
            );

            if (result.changed) {
                await repository.putSnapshot(result.snapshot);
            }

            return result;
        },
    );
}

async function readRtcTopologyRttMeasurements(
    group: GroupSnapshot,
    runtimeState?: RtcTopologyRuntimeState,
): Promise<readonly RttMeasurementInfo[]> {
    if (!runtimeState) {
        return rttRepository.getAllRtt();
    }

    return await runtimeState.rtts.listMeasurementsForSessionIds(
        group.activeSessions.map((session) => session.sessionId),
    );
}

async function removeRtcOverlayTopology(
    group: GroupSnapshot,
    rtcTopologyService: RallarRtcTopologyService,
    rtcTopologyFlushTimers: Map<string, RtcTopologyFlushTimer>,
    runtimeState?: RtcTopologyRuntimeState,
): Promise<void> {
    const overlayId = toScopedOverlayId(group.group);
    const timer = rtcTopologyFlushTimers.get(overlayId);
    if (timer) {
        clearTimeout(timer);
        rtcTopologyFlushTimers.delete(overlayId);
    }

    rtcTopologyService.removeGroupTopology(group);

    if (!runtimeState) {
        return;
    }

    await runtimeState.topologySnapshots.withSnapshotLock(
        group.group,
        async (repository) => {
            await repository.removeSnapshot(group.group);
        },
    );
}

function publishRtcOverlayTopologyResult(
    group: GroupSnapshot,
    server: JsonWebSocketServer,
    result: RallarRtcTopologyUpdateResult,
    rtcTopologyService?: RallarRtcTopologyService,
): void {
    rtcTopologyService?.recordTopologyPublishResult(result.changed);

    if (!result.changed) {
        return;
    }

    const message = newALBroadcastMessage(
        'rallar-server',
        newALRoute(
            AppTopics.overlayTopology,
            group.group.groupId,
            `${result.snapshot.overlayId}:${result.snapshot.version}`,
        ),
        'room',
        AppTopics.overlayTopology,
        result.snapshot,
        {
            groupRef: group.group,
            minSnapshotVersion: group.group.snapshotVersion,
            reliability: 'best-effort',
            ack: 'none',
        },
    );

    sendStateSyncMessage(server, message);
}

function scheduleRtcOverlayTopologyFlush(
    group: GroupSnapshot,
    server: JsonWebSocketServer,
    rtcTopologyService: RallarRtcTopologyService,
    rtcTopologyFlushTimers: Map<string, RtcTopologyFlushTimer>,
    runtimeState?: RtcTopologyRuntimeState,
): void {
    const queued = rtcTopologyService.queueRttTopologyUpdate(group);

    if (queued.immediate) {
        void publishDueRtcOverlayTopology(
            group,
            server,
            rtcTopologyService,
            runtimeState,
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
                rtcTopologyService,
                runtimeState,
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
                    runtimeState,
                );
            }
        })();
    }, queued.delayMs);

    rtcTopologyFlushTimers.set(queued.overlayId, timer);
}

function scheduleRtcOverlayTopologyFlushesForRtt(
    rtt: RttMeasurementInfo,
    server: JsonWebSocketServer,
    rtcTopologyService: RallarRtcTopologyService,
    rtcTopologyFlushTimers: Map<string, RtcTopologyFlushTimer>,
    runtimeState?: RtcTopologyRuntimeState,
): void {
    for (const group of findGroupsAffectedByRtt(rtt)) {
        scheduleRtcOverlayTopologyFlush(
            group,
            server,
            rtcTopologyService,
            rtcTopologyFlushTimers,
            runtimeState,
        );
    }
}

function findGroupsAffectedByRtt(
    rtt: RttMeasurementInfo,
): readonly GroupSnapshot[] {
    return groupStateSnapshotsRepository.findGroupStateSnapshotsBySessionIds([
        rtt.sessionIdFrom,
        rtt.sessionIdTo,
    ]);
}

function initRtcTopologyAppInboxTopic(
    inboxQueueReader: InboxQueueReader,
    wsQBoxServerService: WsQueueBoxServerService,
    rtcTopologyService: RallarRtcTopologyService,
    rtcTopologyAppInbox: RtcTopologyAppInboxRuntime,
): void {
    inboxQueueReader.onInboxMessageDo(AppInboxType.RTC_TOPOLOGY_RECOMPUTE, {
        onMessage: async (_message: ALMessage, entry: ResourceEntry) => {
            const work =
                rtcTopologyAppInbox.service.readEnvelope<RtcTopologyRecomputeWork>(
                    entry,
                );
            const group = await rtcTopologyAppInbox.findGroupSnapshotByRef(
                work.data.groupRef,
                {
                    minSnapshotVersion: work.data.minGroupSnapshotVersion,
                },
            );

            if (!group) {
                throw new Error(
                    `Group snapshot not found for RTC topology work ${work.data.overlayId}`,
                );
            }

            await publishRtcOverlayTopology(
                group,
                wsQBoxServerService.socket,
                rtcTopologyService,
                rtcTopologyAppInbox.runtimeState,
            );

            if (await rtcTopologyAppInbox.service.isReservedEntryStale(entry)) {
                throw new Error(
                    `Coalesced RTC topology work advanced while processing ${work.data.overlayId}`,
                );
            }
        },
    });
}

async function enqueueRtcTopologyAppInboxWorkForGroupSnapshot(
    group: GroupSnapshot,
    rtcTopologyAppInbox: RtcTopologyAppInboxRuntime,
): Promise<void> {
    const overlayId = toScopedOverlayId(group.group);
    await rtcTopologyAppInbox.service.enqueue<RtcTopologyRecomputeWork>({
        type: AppInboxType.RTC_TOPOLOGY_RECOMPUTE,
        topicId: rtcTopologyAppInbox.topicId,
        resourceId: overlayId,
        contextId: toRtcTopologyAppInboxContextId(group.group),
        data: {
            overlayId,
            groupRef: group.group,
            minGroupSnapshotVersion: group.group.snapshotVersion,
        },
        reason: 'group-snapshot',
        dueAtEpochMs: Date.now(),
        merge: mergeRtcTopologyWork,
    });
    rtcTopologyAppInbox.wake?.();
}

async function enqueueRtcTopologyAppInboxWorkForRtt(
    group: GroupSnapshot,
    rtt: RttMeasurementInfo,
    rtcTopologyService: RallarRtcTopologyService,
    rtcTopologyAppInbox: RtcTopologyAppInboxRuntime,
): Promise<void> {
    const overlayId = toScopedOverlayId(group.group);
    await rtcTopologyAppInbox.service.enqueue<RtcTopologyRecomputeWork>({
        type: AppInboxType.RTC_TOPOLOGY_RECOMPUTE,
        topicId: rtcTopologyAppInbox.topicId,
        resourceId: overlayId,
        contextId: toRtcTopologyAppInboxContextId(group.group),
        data: {
            overlayId,
            groupRef: group.group,
            minGroupSnapshotVersion: group.group.snapshotVersion,
            minRttVersion: rtt.version,
        },
        reason: 'rtt',
        dueAtEpochMs: Date.now() + rtcTopologyService.readRttRebuildDebounceMs(),
        merge: mergeRtcTopologyWork,
    });
    rtcTopologyAppInbox.wake?.();
}

async function enqueueRtcTopologyAppInboxWorkForRttGroups(
    rtt: RttMeasurementInfo,
    rtcTopologyService: RallarRtcTopologyService,
    rtcTopologyAppInbox: RtcTopologyAppInboxRuntime,
): Promise<void> {
    for (const group of findGroupsAffectedByRtt(rtt)) {
        await enqueueRtcTopologyAppInboxWorkForRtt(
            group,
            rtt,
            rtcTopologyService,
            rtcTopologyAppInbox,
        );
    }
}

function mergeRtcTopologyWork(
    existing: CoalescedAppInboxWorkData<RtcTopologyRecomputeWork>,
    incoming: CoalescedAppInboxWorkData<RtcTopologyRecomputeWork>,
): CoalescedAppInboxWorkData<RtcTopologyRecomputeWork> {
    const previous = existing[COALESCED_APP_INBOX_WORK_FIELD];
    const next = incoming[COALESCED_APP_INBOX_WORK_FIELD];
    const reasons = uniqueStrings([...previous.reasons, ...next.reasons]);
    const dueAtEpochMs = reasons.includes('group-snapshot')
        ? Math.min(previous.dueAtEpochMs, next.dueAtEpochMs)
        : Math.max(previous.dueAtEpochMs, next.dueAtEpochMs);

    return {
        ...incoming,
        minGroupSnapshotVersion: Math.max(
            existing.minGroupSnapshotVersion,
            incoming.minGroupSnapshotVersion,
        ),
        minRttVersion: Math.max(
            existing.minRttVersion ?? 0,
            incoming.minRttVersion ?? 0,
        ),
        [COALESCED_APP_INBOX_WORK_FIELD]: {
            ...next,
            dueAtEpochMs,
            reasons,
        },
    };
}

function toRtcTopologyAppInboxContextId(groupRef: GroupRef): string {
    return [
        groupRef.applicationId,
        groupRef.workspaceId ?? '',
        groupRef.groupId,
    ].join(':');
}

function uniqueStrings(values: readonly string[]): readonly string[] {
    return [...new Set(values)];
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
    rtcTopologyAppInbox?: RtcTopologyAppInboxRuntime,
    runtimeState?: RtcTopologyRuntimeState,
): void {
    wsQBoxServerService.onInboxMessageDo(AppTopics.rtt, {
        onMessage: async (data: ALMessage, _: ResourceEntry, server: JsonWebSocketServer) => {
            if (!isTopic(data, AppTopics.rtt)) {
                return;
            }

            const rtt: RttMeasurementInfo = JSON.parse(data.payload.resource) as RttMeasurementInfo;

            console.log(`Received RTT message: ${data.payload.resource}`);

            const isUpdated = await acceptRtcRttMeasurement(rtt, runtimeState);
            if (isUpdated) {
                vivaldiService.observeRtt(rtt);
                computeGlobalGraphAndCacheItIfPossible();
                if (rtcTopologyAppInbox) {
                    await enqueueRtcTopologyAppInboxWorkForRttGroups(
                        rtt,
                        rtcTopologyService,
                        rtcTopologyAppInbox,
                    );
                } else {
                    scheduleRtcOverlayTopologyFlushesForRtt(
                        rtt,
                        server,
                        rtcTopologyService,
                        rtcTopologyFlushTimers,
                        runtimeState,
                    );
                }
            }
        },
    });
}

async function acceptRtcRttMeasurement(
    rtt: RttMeasurementInfo,
    runtimeState?: RtcTopologyRuntimeState,
): Promise<boolean> {
    if (!runtimeState) {
        return rttRepository.setRtt(rtt);
    }

    const accepted = await runtimeState.rtts.putMeasurementIfNewer(rtt);
    if (accepted) {
        rttRepository.setRtt(rtt);
    }

    return accepted;
}

function computeGlobalGraphAndCacheItIfPossible(): void {
    try {
        computeGlobalGraphAndCacheIt();
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
