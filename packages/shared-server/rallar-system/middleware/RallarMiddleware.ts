import type { ALInboundRuntimeStores } from '@shared/alm/ALInboundMessageRuntime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/ALOutboundMessageRuntime.ts';
import { type ALMessage, readALTargetGroupRef, } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import {
    WsQueueBoxServerService,
    type WsServerResolvedRecipient,
    type WsServerTargetResolver,
} from '@shared/services/WsQueueBoxServerService.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { initialiseServerCacheRepositories } from '../cache-repositories.ts';
import type { ClientStateRepository } from '../repositories/ClientStateRepository.ts';
import type { GroupStateRepository } from '../repositories/GroupStateRepository.ts';
import type { AppClientInboxService } from '../services/AppClientInboxService.ts';
import type { AppGroupInboxService } from '../services/AppGroupInboxService.ts';
import type { ClientStateService } from '../services/client-state-service.ts';
import type { GroupStateService } from '../services/group-state-service.ts';
import { resolveStateSyncRecipients } from '../state-sync-routing.ts';
import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import { isGroupSnapshotSessionLive, type RallarSnapshotPresenceClock, } from '../snapshot-presence.ts';
import type { RtcTopologyPublicationRepository } from '../repositories/RtcTopologyPublicationRepository.ts';
import type { RtcTopologyPublicationFanout } from '../pubsub/RtcTopologyClusterTransport.ts';
import type { RtcTopologyExecutionRepository } from '../repositories/RtcTopologyExecutionRepository.ts';
import { AppOutboxType } from '../services/AppOutboxService.ts';
import {
    StateMutationOutboxWork,
    type StateMutationOutboxWorkOptions,
    type StateMutationOutboxWorkLike,
} from '../services/StateMutationOutboxWork.ts';
import {
    createWsStateSyncPublisher,
    type StateSyncPublisher,
} from '../state-sync-publisher.ts';

export type RallarStateMutationOutboxOptions =
    & Omit<StateMutationOutboxWorkOptions, 'stateSyncPublisher'>
    & Readonly<{
        stateSyncPublisher?: StateSyncPublisher;
        stateSyncServerId?: string;
    }>;

export type RallarStateMutationOutboxFactoryInput = Readonly<{
    outboxQueueReader: OutboxQueueReader;
    wakeQueueEngine: () => void;
}>;

export type RallarStateMutationOutboxConfiguration =
    | RallarStateMutationOutboxOptions
    | ((
        input: RallarStateMutationOutboxFactoryInput,
    ) => RallarStateMutationOutboxOptions);

export type RallarMiddlewareRuntime = Readonly<{
    qboxEngine: InboxOutboxEngine;
    wsQBoxServerService: WsQueueBoxServerService;
    inboxQueueReader: InboxQueueReader;
    outboxQueueReader: OutboxQueueReader;
    appInboxResilience: ResilienceDto;
    appOutboxResilience: ResilienceDto;
    appGroupInboxService: AppGroupInboxService;
    appClientInboxService: AppClientInboxService;
    clientStateService: ClientStateService;
    groupStateService: GroupStateService;
    clientsRepository: ClientStateRepository;
    groupsRepository: GroupStateRepository;
    rtcTopologyPublicationRepository?: RtcTopologyPublicationRepository;
    rtcTopologyExecutionRepository?: RtcTopologyExecutionRepository;
    rtcTopologyPublicationFanout?: RtcTopologyPublicationFanout;
    stateMutationOutboxWork?: StateMutationOutboxWorkLike;
    readiness: Promise<void>;
}>;

export type RallarGroupSnapshotResolverOptions = Readonly<{
    findGroupSnapshotByRef?: (
        ref: GroupRef,
        message: ALMessage,
    ) => GroupSnapshot | undefined;
    findGroupSnapshotById?: (groupId: string) => GroupSnapshot | undefined;
    resolveGroupRef?: (
        groupId: string,
        message: ALMessage,
    ) => GroupRef | undefined;
    now?: RallarSnapshotPresenceClock;
}>;

export type CreateRallarMiddlewareOptions = Readonly<{
    inbox: QueueBoxResourceEntryRepository;
    outbox?: QueueBoxResourceEntryRepository;
    webSocketServer?: JsonWebSocketServer;
    wsRuntimeName?: string;
    targetResolver?: WsServerTargetResolver;
    findGroupSnapshotByRef?: RallarGroupSnapshotResolverOptions['findGroupSnapshotByRef'];
    findGroupSnapshotById?: RallarGroupSnapshotResolverOptions['findGroupSnapshotById'];
    resolveGroupRef?: RallarGroupSnapshotResolverOptions['resolveGroupRef'];
    now?: RallarSnapshotPresenceClock;
    inboundStores?: ALInboundRuntimeStores;
    outboundStores?: ALOutboundRuntimeStores;
    createAppGroupInboxService: (
        input: Readonly<{
            inboxQueueReader: InboxQueueReader;
            outboxQueueReader: OutboxQueueReader;
            wsQBoxServerService: WsQueueBoxServerService;
            appInboxResilience: ResilienceDto;
            appOutboxResilience: ResilienceDto;
            wakeQueueEngine: () => void;
        }>,
    ) => AppGroupInboxService;
    createAppClientInboxService: (
        input: Readonly<{
            inboxQueueReader: InboxQueueReader;
            wsQBoxServerService: WsQueueBoxServerService;
            appInboxResilience: ResilienceDto;
        }>,
    ) => AppClientInboxService;
    resilience: Readonly<{
        inbox: ResilienceDto;
        outbox?: ResilienceDto;
        appInbox?: ResilienceDto;
        appOutbox: ResilienceDto;
    }>;
    clientsRepository: ClientStateRepository;
    groupsRepository: GroupStateRepository;
    rtcTopologyPublicationRepository?: RtcTopologyPublicationRepository;
    rtcTopologyExecutionRepository?: RtcTopologyExecutionRepository;
    rtcTopologyPublicationFanout?: RtcTopologyPublicationFanout;
    stateMutationOutbox?: RallarStateMutationOutboxConfiguration;
    readiness?: Promise<void>;
}>;

export function createRallarMiddleware(
    options: CreateRallarMiddlewareOptions,
): RallarMiddlewareRuntime {
    initialiseServerCacheRepositories();

    const qboxEngine = new InboxOutboxEngine();
    const webSocketServer = options.webSocketServer ?? new JsonWebSocketServer();
    const targetResolver =
        options.targetResolver ??
        createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotByRef: options.findGroupSnapshotByRef,
            findGroupSnapshotById: options.findGroupSnapshotById,
            resolveGroupRef: options.resolveGroupRef,
            now: options.now,
        });

    const wsQBoxServerService = new WsQueueBoxServerService(
        options.inbox,
        options.outbox ?? options.inbox,
        webSocketServer,
        options.wsRuntimeName ?? 'default-qbox-server',
        {
            targetResolver,
            inboundStores: options.inboundStores,
            outboundStores: options.outboundStores,
        },
    );
    const inboxQueueReader = new InboxQueueReader(options.inbox);
    const outboxQueueReader = new OutboxQueueReader(
        options.outbox ?? options.inbox,
    );
    const appInboxResilience =
        options.resilience.appInbox ?? options.resilience.inbox;
    const appOutboxResilience = options.resilience.appOutbox;
    const wakeQueueEngine = () => qboxEngine.wake();
    const stateMutationOutboxOptions = typeof options.stateMutationOutbox ===
            'function'
        ? options.stateMutationOutbox({ outboxQueueReader, wakeQueueEngine })
        : options.stateMutationOutbox;
    const appGroupInboxService = options.createAppGroupInboxService({
        inboxQueueReader,
        outboxQueueReader,
        wsQBoxServerService,
        appInboxResilience,
        appOutboxResilience,
        wakeQueueEngine,
    });
    const appClientInboxService = options.createAppClientInboxService({
        inboxQueueReader,
        wsQBoxServerService,
        appInboxResilience,
    });
    const stateMutationOutboxWork = stateMutationOutboxOptions
        ? new StateMutationOutboxWork({
            repository: stateMutationOutboxOptions.repository,
            readClientSnapshot:
                stateMutationOutboxOptions.readClientSnapshot,
            readGroupSnapshot: stateMutationOutboxOptions.readGroupSnapshot,
            stateSyncPublisher:
                stateMutationOutboxOptions.stateSyncPublisher ??
                createWsStateSyncPublisher(wsQBoxServerService, {
                    serverId:
                        stateMutationOutboxOptions.stateSyncServerId ??
                        options.wsRuntimeName ??
                        'rallar-server',
                }),
            groupPresenceSummaryPublisher:
                stateMutationOutboxOptions.groupPresenceSummaryPublisher,
            rtcTopologyPublisher:
                stateMutationOutboxOptions.rtcTopologyPublisher,
            now: stateMutationOutboxOptions.now,
            sleep: stateMutationOutboxOptions.sleep,
            timing: stateMutationOutboxOptions.timing,
            senderId: stateMutationOutboxOptions.senderId,
            pageSize: stateMutationOutboxOptions.pageSize,
        })
        : undefined;

    includeWsQueueBoxEngineTasks(
        qboxEngine,
        wsQBoxServerService,
        options.resilience.inbox,
        options.resilience.outbox ?? options.resilience.inbox,
    );
    includeInboxQueueReaderEngineTasks(
        qboxEngine,
        inboxQueueReader,
        appInboxResilience,
    );
    includeOutboxQueueReaderEngineTasks(
        qboxEngine,
        outboxQueueReader,
        appOutboxResilience,
    );
    if (stateMutationOutboxWork) {
        includeStateMutationOutboxEngineTask(
            qboxEngine,
            stateMutationOutboxWork,
        );
    }

    return {
        qboxEngine,
        wsQBoxServerService,
        inboxQueueReader,
        outboxQueueReader,
        appInboxResilience,
        appOutboxResilience,
        appGroupInboxService,
        appClientInboxService,
        groupStateService: appGroupInboxService.groupStateService,
        clientStateService: appClientInboxService.clientStateService,
        clientsRepository: options.clientsRepository,
        groupsRepository: options.groupsRepository,
        rtcTopologyPublicationRepository:
            options.rtcTopologyPublicationRepository,
        rtcTopologyExecutionRepository: options.rtcTopologyExecutionRepository,
        rtcTopologyPublicationFanout: options.rtcTopologyPublicationFanout,
        stateMutationOutboxWork,
        readiness: options.readiness ?? Promise.resolve(),
    };
}

export function includeWsQueueBoxEngineTasks(
    engine: InboxOutboxEngine,
    wsQBoxServerService: WsQueueBoxServerService,
    resilienceInbox: ResilienceDto,
    resilienceOutbox: ResilienceDto,
): void {
    engine.includeTask(WsQueueBoxServerService.INBOX_ENQUEUE_TYPE, {
        name: WsQueueBoxServerService.INBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            wsQBoxServerService.inbox.isAnyEntryToLock(
                WsQueueBoxServerService.INBOX_DEQUEUE_TYPES,
                resilienceInbox.toWorkAdvertisementOptions(),
            ),
        runnable: () =>
            wsQBoxServerService.dequeueInbox(
                WsQueueBoxServerService.INBOX_DEQUEUE_TYPES,
                resilienceInbox,
            ),
        ongoingTasks: [],
    });

    engine.includeTask(WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE, {
        name: WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            wsQBoxServerService.outbox.isAnyEntryToLock(
                WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
                resilienceOutbox.toWorkAdvertisementOptions(),
            ),
        runnable: () =>
            wsQBoxServerService.dequeueOutbox(
                WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
                resilienceOutbox,
            ),
        ongoingTasks: [],
    });
}

export function includeInboxQueueReaderEngineTasks(
    engine: InboxOutboxEngine,
    inboxQueueReader: InboxQueueReader,
    resilience: ResilienceDto,
): void {
    engine.includeTask(InboxQueueReader.INBOX_ENQUEUE_TYPE, {
        name: InboxQueueReader.INBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            inboxQueueReader.inbox.isAnyEntryToLock(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                resilience.toWorkAdvertisementOptions(),
            ),
        runnable: () =>
            inboxQueueReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                resilience,
            ),
        ongoingTasks: [],
    });
}

export function includeOutboxQueueReaderEngineTasks(
    engine: InboxOutboxEngine,
    outboxQueueReader: OutboxQueueReader,
    resilience: ResilienceDto,
): void {
    engine.includeTask(OutboxQueueReader.OUTBOX_ENQUEUE_TYPE, {
        name: OutboxQueueReader.OUTBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            outboxQueueReader.outbox.isAnyEntryToLock(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                resilience.toWorkAdvertisementOptions(),
            ),
        runnable: () =>
            outboxQueueReader.dequeueOutbox(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                resilience,
            ),
        ongoingTasks: [],
    });
}

export function includeStateMutationOutboxEngineTask(
    engine: InboxOutboxEngine,
    work: StateMutationOutboxWorkLike,
): void {
    engine.includeTask(AppOutboxType.STATE_MUTATION_OUTBOX_DRAIN, {
        name: AppOutboxType.STATE_MUTATION_OUTBOX_DRAIN,
        maxConcurrency: () => 1,
        isWork: () => work.hasPending(),
        runnable: async () => {
            await work.drainPending();
        },
        ongoingTasks: [],
    });
}

export function createWsServerTargetResolver(
    webSocketServer: JsonWebSocketServer,
    options: RallarGroupSnapshotResolverOptions = {},
): WsServerTargetResolver {
    const resolveGroupSnapshot = (
        groupId: string,
        message: ALMessage,
    ): GroupSnapshot | undefined => {
        const groupRef =
            readALTargetGroupRef(message) ??
            options.resolveGroupRef?.(groupId, message);
        const scopedSnapshot = groupRef
            ? options.findGroupSnapshotByRef?.(groupRef, message)
            : undefined;
        if (scopedSnapshot) {
            return scopedSnapshot;
        }

        const byIdSnapshot = options.findGroupSnapshotById?.(groupId);
        if (!byIdSnapshot) {
            return undefined;
        }

        return groupRef === undefined ||
        isSameGroupScope(byIdSnapshot.group, groupRef)
            ? byIdSnapshot
            : undefined;
    };

    const resolveGroupRecipients = (
        groupId: string,
        message: ALMessage,
    ): readonly WsServerResolvedRecipient[] => {
        const snapshot = resolveGroupSnapshot(groupId, message);
        if (!snapshot) {
            return [];
        }

        return snapshot.activeSessions
            .filter(
                (session) =>
                    isGroupSnapshotSessionLive(
                        session,
                        options.now?.() ?? Date.now(),
                    ) &&
                    webSocketServer.connections.get(session.sessionId)?.isOpen,
            )
            .map((session) => ({
                peerId: session.sessionId,
                connectionId: session.sessionId,
            }));
    };

    const resolveAllOpenConnections = (
        message: ALMessage,
    ): readonly WsServerResolvedRecipient[] => {
        const stateSyncRecipients = resolveStateSyncRecipients(
            webSocketServer,
            message,
            {
                findGroupSnapshotByRef: (ref) =>
                    options.findGroupSnapshotByRef?.(ref, message),
                findGroupSnapshotById: options.findGroupSnapshotById,
                now: options.now,
            },
        );
        if (stateSyncRecipients) {
            return stateSyncRecipients;
        }

        return [...webSocketServer.connections.values()]
            .filter((ctx) => ctx.isOpen)
            .map((ctx) => ({
                peerId: ctx.id,
                connectionId: ctx.id,
            }));
    };

    return {
        resolvePeerRecipients: (peerId) => {
            const ctx = webSocketServer.connections.get(peerId);
            return ctx?.isOpen
                ? [
                    {
                        peerId,
                        connectionId: peerId,
                    },
                ]
                : [];
        },
        resolveGroupRecipients: (groupId, _message: ALMessage) =>
            resolveGroupRecipients(groupId, _message),
        resolveBroadcastRecipients: (scope, message) => {
            if (scope === 'room') {
                return resolveGroupRecipients(
                    readALTargetGroupRef(message)?.groupId ?? message.route.contextId,
                    message,
                );
            }

            return resolveAllOpenConnections(message);
        },
        resolvePeerIdForConnection: (connectionId) => connectionId,
    };
}
