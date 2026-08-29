import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/ALOutboundMessageRuntime.ts';
import {
    ApiConfig,
    AppTopics,
    AuthSession,
    ClientInfo,
    IceConfig,
    RttMeasurementInfo
} from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command, type CommandOptions } from '@shared/cache/Command.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/WebRtcOverlayMulticastManager.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import { pairKey } from '@shared/repository/rtt-repository.ts';
import { resolveBootstrapDegree } from '@shared/rtc/bootstrap-peer-selection.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import {
    QRtcPeerDto,
    WebRtcConnectionService,
    type RtcDataChannelLaneConfig,
    type WebRtcInboundPeerCreationDecision
} from '@shared/services/WebRtcConnectionService.ts';
import { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';
import { WebRtcRxStreamerService } from '@shared/services/WebRtcRxStreamerService.ts';
import {
    DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS,
    WsQueueBoxClientService
} from '@shared/services/WsQueueBoxClientService.ts';
import { JsonWebSocketClient } from '@shared/websocket/JsonWebSocketClient.ts';

import { readSession } from '@shared/api/auth.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { createWebSocketTicket } from '@shared-web/browser/auth/websocket-ticket-http-api.ts';
import { readApiConfig, readIceCandidates } from '@shared-web/browser/connection/connection-http-api.ts';
import type { RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { DEFAULT_REALTIME_DATA_CHANNEL_LANE } from '@shared-web/browser/rallar-realtime-facade.ts';
import { initGroupStateResyncOnReopen } from '@shared-web/browser/state-read/group-state-resync-on-reopen.ts';
import { hydrateGroupTopologyOverlays } from '@shared-web/browser/state-read/hydrate-group-topology-overlays.ts';
import { refreshStateSnapshots } from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import { toResilienceDto } from '../resilience-config.ts';

import { initBrowserALRuntimeExpiryEviction } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { initBrowserQueueBoxExpiryEviction } from '@shared-web/browser/queuebox/browser-queuebox-persistence.ts';
import { createBrowserQueueBoxEngine } from '@shared-web/browser/queuebox/create-browser-queue-box-engine.ts';
import * as rtcEngine from '@shared-web/browser/rtc/initialise-browser-rtc-runtime.ts';
import * as heartbeat from '@shared-web/browser/session/browser-session-heartbeat.ts';
import { initialiseBrowserCacheRepositories } from '@shared-web/browser/state-cache/initialise-browser-cache-repositories.ts';
import { createBrowserWebSocketQueueBox } from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
import {
    browserStateCacheLifecycle,
    type StateCacheScopeOptions
} from '../state-cache/browser-state-cache-lifecycle.ts';

export interface MiddlewareInitOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    readonly maxPeerConnections?: number;
    readonly rttReportingDegreeLimit?: number;
    readonly bootstrapDegree?: number;
    readonly scope?: StateScope;
    readonly onAuthInvalid?: (error: unknown) => void | Promise<void>;
    readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
}

export interface ToCreateWsUrlInput {
    readonly apiConfig: ApiConfig;
    readonly session: AuthSession;
    readonly ticket: string;
    readonly scope?: StateScope;
}

export const BROWSER_RTT_HEARTBEAT_TTL_MS = 15_000;

export function toCreateWsUrl(
    input: ToCreateWsUrlInput
): string {
    const path = input.apiConfig.endpoints.createWs.replace(
        ':id',
        encodeURIComponent(input.session.sessionId)
    );
    const url = new URL(path, input.apiConfig.wsBaseUrl);
    url.searchParams.set('ticket', input.ticket);
    if (input.scope) {
        url.searchParams.set('applicationId', input.scope.applicationId);
        url.searchParams.set('workspaceId', input.scope.workspaceId);
    }
    return url.toString();
}

export function toBrowserRttHeartbeatMessage(
    sessionId: string,
    rtt: RttMeasurementInfo
) {
    return newALUntargetedMessage<RttMeasurementInfo>(
        sessionId,
        newALRoute(
            AppTopics.rtt,
            pairKey(rtt.sessionIdFrom, rtt.sessionIdTo),
            `${rtt.version}`
        ),
        AppTopics.rtt,
        rtt,
        {
            ttlMs: BROWSER_RTT_HEARTBEAT_TTL_MS
        }
    );
}

export function toBrowserRtcInboundPeerCreationDecision(
    isPeerOwnedByAnyGroup: boolean
): WebRtcInboundPeerCreationDecision {
    return isPeerOwnedByAnyGroup ? { decision: 'allow' } : {
        decision: 'tentative',
        reason: 'group-state-eventually-consistent'
    };
}

interface BrowserWebSocketTransport {
    readonly qboxEngine: InboxOutboxEngine;
    readonly webSocketQueueBox: WsQueueBoxClientService;
}

interface BrowserRtcTransport {
    readonly webRtcConnectionService: WebRtcConnectionService;
    readonly rtcRxStreamer: WebRtcRxStreamerService;
    readonly webRtcGroupManager: WebRtcGroupManager;
    readonly webRtcOverlayMulticastManager: WebRtcOverlayMulticastManager;
}

interface InitialiseBrowserTransportInput {
    readonly session: AuthSession;
    readonly clientData: ClientInfo;
    readonly options: MiddlewareInitOptions;
}

interface InitialiseBrowserRtcTransportInput extends InitialiseBrowserTransportInput {
    readonly rtcSignalingTopicId: string;
    readonly webSocketTransport: BrowserWebSocketTransport;
}

interface InitialiseBrowserStateTransportInput extends InitialiseBrowserTransportInput {
    readonly webSocketQueueBox: WsQueueBoxClientService;
    readonly webRtcGroupManager: WebRtcGroupManager;
    readonly bootstrapDegree: number;
}

export async function initialiseMiddleware(
    session: AuthSession,
    rtcSignalingTopicId: string,
    options: MiddlewareInitOptions = {}
): Promise<RallarBrowserMiddleware> {
    const clientData: ClientInfo = {
        clientId: session.clientId,
        sessionId: session.sessionId,
        isOnline: true
    };
    initialiseBrowserRuntimeStores(clientData.sessionId);
    const transportInput = { session, clientData, options };
    const webSocketTransport = await initialiseBrowserWebSocketTransport(transportInput);
    const rtcTransport = await initialiseBrowserRtcTransport({
        ...transportInput,
        rtcSignalingTopicId,
        webSocketTransport
    });
    const bootstrapDegree = resolveBootstrapDegree({
        bootstrapDegree: options.bootstrapDegree,
        maxPeerConnections: options.maxPeerConnections
    });
    await initialiseBrowserStateTransport({
        ...transportInput,
        webSocketQueueBox: webSocketTransport.webSocketQueueBox,
        webRtcGroupManager: rtcTransport.webRtcGroupManager,
        bootstrapDegree
    });
    const heartbeatHandle = await heartbeat.initHeartbeat(clientData, {
        authSession: session,
        scope: options.scope,
        onAuthInvalid: options.onAuthInvalid
    });

    return {
        ...webSocketTransport,
        ...rtcTransport,
        heartbeat: heartbeatHandle
    };
}

function initialiseBrowserRuntimeStores(sessionId: string): void {
    initialiseBrowserCacheRepositories();
    configureBrowserALRuntimeStores(sessionId);
    initBrowserALRuntimeExpiryEviction().catch((error) =>
        console.error('Failed to initialise browser AL runtime expiry eviction:', error)
    );
    initBrowserQueueBoxExpiryEviction().catch((error) =>
        console.error('Failed to initialise browser queuebox expiry eviction:', error)
    );
}

async function initialiseBrowserWebSocketTransport(
    input: InitialiseBrowserTransportInput
): Promise<BrowserWebSocketTransport> {
    const apiConfig = await runMiddlewareCommand(
        (signal) => readApiConfig({ signal }),
        input.options
    );
    const socket = createBrowserWebSocketClient(input, apiConfig);
    const qboxEngine = createBrowserQueueBoxEngine();
    const webSocketQueueBox = await createBrowserWebSocketQueueBox({
        qboxEngine,
        socket,
        clientData: input.clientData,
        resilience: toResilienceDto(),
        signal: input.options.signal,
        connectTimeoutMs: input.options.timeoutMs ??
            DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS.connectTimeoutMsecs,
        newConnectionRequestId: () => crypto.randomUUID(),
        outboundDiagnostics: input.options.outboundDiagnostics
    }).catch((error) => {
        console.error('Failed to connect WebSocket client:', error);
        throw error;
    });
    return { qboxEngine, webSocketQueueBox };
}

function createBrowserWebSocketClient(
    input: InitialiseBrowserTransportInput,
    apiConfig: ApiConfig
): JsonWebSocketClient {
    return new JsonWebSocketClient(async (connectOptions) => {
        if (!connectOptions.requestId) {
            throw new Error('WebSocket connection request identity is missing.');
        }
        const wsTicket = await createWebSocketTicket({
            requestId: connectOptions.requestId,
            signal: connectOptions.signal
        });
        if (wsTicket.sessionId !== input.session.sessionId) {
            throw new Error('WebSocket ticket does not match the current session.');
        }
        return toCreateWsUrl({
            apiConfig,
            session: input.session,
            ticket: wsTicket.ticket,
            scope: input.options.scope
        });
    });
}

async function initialiseBrowserRtcTransport(
    input: InitialiseBrowserRtcTransportInput
): Promise<BrowserRtcTransport> {
    const iceCandidates: IceConfig = await runMiddlewareCommand(
        (signal) => readIceCandidates({ signal }),
        input.options
    );
    const webRtcConnectionService = await initialiseBrowserRtcConnection(
        input,
        iceCandidates
    );
    const webRtcOverlayMulticastManager = rtcEngine.initialiseRtcOverlayMulticastManager(
        {
            webRtcConnectionService,
            qboxEngine: input.webSocketTransport.qboxEngine,
            resilience: toResilienceDto(),
            outboundDiagnostics: input.options.outboundDiagnostics
        }
    );
    const rtcRxStreamer = rtcEngine.initialiseRtcRxStreamer(
        {
            webRtcOverlayMulticastManager,
            qboxEngine: input.webSocketTransport.qboxEngine,
            clientData: input.clientData,
            resilience: toResilienceDto()
        }
    );
    registerBrowserRttEgress(input, rtcRxStreamer);
    registerBrowserRtcPeerStreaming(webRtcConnectionService, rtcRxStreamer);
    const webRtcGroupManager = createBrowserRtcGroupManager(
        input,
        webRtcConnectionService,
        rtcRxStreamer
    );
    return {
        webRtcConnectionService,
        rtcRxStreamer,
        webRtcGroupManager,
        webRtcOverlayMulticastManager
    };
}

function initialiseBrowserRtcConnection(
    input: InitialiseBrowserRtcTransportInput,
    iceCandidates: IceConfig
): Promise<WebRtcConnectionService> {
    return rtcEngine.initialiseRtcConnectionService({
        webSocketQueueBox: input.webSocketTransport.webSocketQueueBox,
        qboxEngine: input.webSocketTransport.qboxEngine,
        clientData: input.clientData,
        iceCandidates,
        dataChannelName: 'rtc-data-channel',
        rtcSignalingTopicId: input.rtcSignalingTopicId,
        dataChannelLanes: input.options.dataChannelLanes ??
            [DEFAULT_REALTIME_DATA_CHANNEL_LANE],
        maxPeerConnections: input.options.maxPeerConnections
    });
}

function registerBrowserRttEgress(
    input: InitialiseBrowserRtcTransportInput,
    rtcRxStreamer: WebRtcRxStreamerService
): void {
    rtcRxStreamer.onRttMeasurementDo(AppTopics.rtt, {
        onHeartbeat: (rtt: RttMeasurementInfo): Promise<void> => {
            const queueBox = input.webSocketTransport;
            void queueBox.webSocketQueueBox.enqueueOutboxIfAbsent(
                toBrowserRttHeartbeatMessage(input.clientData.sessionId, rtt)
            ).then((result) => {
                if (result.status === 'enqueued' || result.status === 'duplicate') {
                    queueBox.qboxEngine.wake();
                }
            }).catch((error) => {
                console.error('Failed to enqueue RTT heartbeat', error);
            });
            return Promise.resolve();
        }
    });
}

function registerBrowserRtcPeerStreaming(
    webRtcConnectionService: WebRtcConnectionService,
    rtcRxStreamer: WebRtcRxStreamerService
): void {
    webRtcConnectionService.onRtcPeerLifecycleDo('rtc-rx-streamer', {
        onCreated(peerDto: QRtcPeerDto) {
            rtcRxStreamer.addPeer(peerDto);
        },
        onDeleted(peerDto: QRtcPeerDto) {
            rtcRxStreamer.removePeer(peerDto);
        }
    });
}

function createBrowserRtcGroupManager(
    input: InitialiseBrowserRtcTransportInput,
    webRtcConnectionService: WebRtcConnectionService,
    rtcRxStreamer: WebRtcRxStreamerService
): WebRtcGroupManager {
    const webRtcGroupManager = new WebRtcGroupManager(
        webRtcConnectionService,
        {
            groupCache: groupStateSnapshotsRepository.readableGroupStateSnapshotCache(),
            clientCache: clientStateSnapshotsRepository.readableClientStateSnapshotCache(),
            plannedOverlayCache: overlaysRepository.readablePlannedOverlayCache(),
            acceptedOverlayCache: overlaysRepository.readableAcceptedOverlayCache()
        },
        {
            maxPeerConnections: input.options.maxPeerConnections,
            onDesiredPeerIdsChanged: refreshRttReportingPeers
        }
    );
    function refreshRttReportingPeers(): void {
        rtcRxStreamer.setRttReportingPeerIds(
            webRtcGroupManager.rttReportingPeerIds({
                degreeLimit: input.options.rttReportingDegreeLimit
            })
        );
    }
    refreshRttReportingPeers();
    webRtcConnectionService.setInboundPeerCreationPolicy(({ peerId }) =>
        toBrowserRtcInboundPeerCreationDecision(
            webRtcGroupManager.isPeerOwnedByAnyGroup(peerId)
        )
    );
    return webRtcGroupManager;
}

async function initialiseBrowserStateTransport(
    input: InitialiseBrowserStateTransportInput
): Promise<void> {
    const stateCacheOptions: StateCacheScopeOptions = {
        scope: input.options.scope,
        rereadGroupSnapshots: async () =>
            (await refreshStateSnapshots(input.options.scope, {
                command: toCommandOptions(input.options)
            })).groups,
        groupFormation: { bootstrapDegree: input.bootstrapDegree }
    };
    browserStateCacheLifecycle.initialise({
        inbox: input.webSocketQueueBox,
        webRtcGroupManager: input.webRtcGroupManager,
        clientData: input.clientData,
        options: stateCacheOptions
    });
    const snapshots = await refreshStateSnapshots(input.options.scope, {
        command: toCommandOptions(input.options)
    });
    await hydrateBrowserStateCaches(input, stateCacheOptions, snapshots);
    await hydrateBrowserGroupTopologies(input, snapshots.groups);
    installBrowserStateResync(input, stateCacheOptions);
}

async function hydrateBrowserStateCaches(
    input: InitialiseBrowserStateTransportInput,
    stateCacheOptions: StateCacheScopeOptions,
    snapshots: Awaited<ReturnType<typeof refreshStateSnapshots>>
): Promise<void> {
    await browserStateCacheLifecycle.hydrate({
        webRtcGroupManager: input.webRtcGroupManager,
        clientData: input.clientData,
        clientSnapshots: snapshots.clients,
        groupSnapshots: snapshots.groups,
        options: stateCacheOptions
    });
}

async function hydrateBrowserGroupTopologies(
    input: InitialiseBrowserStateTransportInput,
    groupSnapshots: readonly GroupSnapshot[]
): Promise<void> {
    await hydrateGroupTopologyOverlays({
        groupSnapshots,
        sessionId: input.clientData.sessionId,
        webRtcGroupManager: input.webRtcGroupManager,
        scope: input.options.scope ?? defaultStateScope(),
        apiRequest: { authSession: input.session }
    });
}

function installBrowserStateResync(
    input: InitialiseBrowserStateTransportInput,
    stateCacheOptions: StateCacheScopeOptions
): void {
    initGroupStateResyncOnReopen({
        socket: input.webSocketQueueBox.socket,
        resyncStateSnapshots: async () => {
            const refreshed = await refreshStateSnapshots(input.options.scope, {
                command: toCommandOptions(input.options)
            });
            await hydrateBrowserStateCaches(input, stateCacheOptions, refreshed);
            return refreshed.groups;
        },
        resyncGroupTopologies: async (refreshedGroups) => {
            await hydrateBrowserGroupTopologies(input, refreshedGroups);
        },
        isCurrentGeneration: () => readSession()?.sessionId === input.clientData.sessionId
    });
}

function runMiddlewareCommand<T>(
    supplier: (signal?: AbortSignal) => T | Promise<T>,
    options: MiddlewareInitOptions
): Promise<T> {
    return new Command<T>(supplier, toCommandOptions(options)).run();
}

function toCommandOptions<T>(
    options: MiddlewareInitOptions
): CommandOptions<T> {
    return {
        signal: options.signal,
        timeoutMs: options.timeoutMs
    };
}
