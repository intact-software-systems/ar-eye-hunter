import {
    ApiConfig,
    AppTopics,
    AuthSession,
    ClientInfo,
    IceConfig,
    RttMeasurementInfo,
} from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command, type CommandOptions } from '@shared/cache/Command.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import {
    QRtcPeerDto,
    type RtcDataChannelLaneConfig,
    type WebRtcInboundPeerCreationDecision,
    WebRtcConnectionService,
} from '@shared/services/WebRtcConnectionService.ts';
import {
    DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS,
    WsQueueBoxClientService,
} from '@shared/services/WsQueueBoxClientService.ts';
import { JsonWebSocketClient } from '@shared/websocket/JsonWebSocketClient.ts';
import { WebRtcRxStreamerService } from '@shared/services/WebRtcRxStreamerService.ts';
import { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/WebRtcOverlayMulticastManager.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/ALOutboundMessageRuntime.ts';
import { pairKey } from '@shared/repository/rtt-repository.ts';

import { createWebSocketTicket, readApiConfig, readIceCandidates, } from '@shared-web/browser/api-integration.ts';
import { refreshStateSnapshots } from '@shared-web/browser/api-workflows.ts';
import { toResilienceDto } from './resilience-config.ts';

import * as cache from './data-caches.ts';
import * as qbox from '@shared-web/browser/qbox-engine.ts';
import * as rtcEngine from '@shared-web/browser/rtc-engine.ts';
import * as wsEngine from '@shared-web/browser/ws-engine.ts';
import type { HeartbeatHandle } from '@shared-web/browser/heartbeat.ts';
import * as heartbeat from '@shared-web/browser/heartbeat.ts';
import { initialiseBrowserCacheRepositories } from '@shared-web/browser/browser-cache-repositories.ts';
import {
    configureBrowserALRuntimeStores,
    initBrowserALRuntimeExpiryEviction,
} from '@shared-web/browser/browser-al-runtime-stores.ts';
import { initBrowserQueueBoxExpiryEviction } from '@shared-web/browser/browser-queuebox.ts';

export type Middleware = {
    qboxEngine: InboxOutboxEngine;
    webSocketQueueBox: WsQueueBoxClientService;
    webRtcConnectionService: WebRtcConnectionService;
    rtcRxStreamer: WebRtcRxStreamerService;
    webRtcGroupManager: WebRtcGroupManager;
    webRtcOverlayMulticastManager: WebRtcOverlayMulticastManager;
    heartbeat: HeartbeatHandle;
};

export type MiddlewareInitOptions = Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
    dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    maxPeerConnections?: number;
    rttReportingDegreeLimit?: number;
    scope?: StateScope;
    onAuthInvalid?: (error: unknown) => void | Promise<void>;
    outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
}>;

export const BROWSER_RTT_HEARTBEAT_TTL_MS = 15_000;

export const DEFAULT_REALTIME_DATA_CHANNEL_LANE: RtcDataChannelLaneConfig = {
    id: 'realtime',
    label: 'rtc-realtime',
    init: {
        ordered: false,
        maxRetransmits: 0,
    },
    binaryType: 'arraybuffer',
    flowControl: {
        highWatermarkBytes: 64 * 1024,
        lowWatermarkBytes: 16 * 1024,
        overflow: 'replace-by-key',
        maxQueueItems: 64,
    },
};

export function toCreateWsUrl(
    apiConfig: ApiConfig,
    session: AuthSession,
    ticket: string,
    scope?: StateScope,
): string {
    const path = apiConfig.endpoints.createWs.replace(
        ':id',
        encodeURIComponent(session.sessionId),
    );
    const url = new URL(path, apiConfig.wsBaseUrl);
    url.searchParams.set('ticket', ticket);
    if (scope) {
        url.searchParams.set('applicationId', scope.applicationId);
        url.searchParams.set('workspaceId', scope.workspaceId);
    }
    return url.toString();
}

export function toBrowserRttHeartbeatMessage(
    sessionId: string,
    rtt: RttMeasurementInfo,
) {
    return newALUntargetedMessage<RttMeasurementInfo>(
        sessionId,
        newALRoute(
            AppTopics.rtt,
            pairKey(rtt.sessionIdFrom, rtt.sessionIdTo),
            `${rtt.version}`,
        ),
        AppTopics.rtt,
        rtt,
        {
            ttlMs: BROWSER_RTT_HEARTBEAT_TTL_MS,
        },
    );
}

export function toBrowserRtcInboundPeerCreationDecision(
    isPeerOwnedByAnyGroup: boolean,
): WebRtcInboundPeerCreationDecision {
    return isPeerOwnedByAnyGroup
        ? { decision: 'allow' }
        : {
            decision: 'tentative',
            reason: 'group-state-eventually-consistent',
        };
}

export async function initialiseMiddleware(
    session: AuthSession,
    rtcSignalingTopicId: string,
    options: MiddlewareInitOptions = {},
): Promise<Middleware> {
    const clientData: ClientInfo = {
        clientId: session.clientId,
        sessionId: session.sessionId,
        isOnline: true,
    };
    initialiseBrowserCacheRepositories();
    configureBrowserALRuntimeStores(clientData.sessionId);
    initBrowserALRuntimeExpiryEviction().catch((error) =>
        console.error('Failed to initialise browser AL runtime expiry eviction:', error)
    );
    initBrowserQueueBoxExpiryEviction().catch((error) =>
        console.error('Failed to initialise browser queuebox expiry eviction:', error)
    );

    const apiConfig = await runMiddlewareCommand(
        (signal) => readApiConfig({ signal }),
        options,
    );

    const socket = new JsonWebSocketClient(async (connectOptions) => {
        const wsTicket = await createWebSocketTicket({ signal: connectOptions.signal });
        if (wsTicket.sessionId !== session.sessionId) {
            throw new Error('WebSocket ticket does not match the current session.');
        }

        return toCreateWsUrl(apiConfig, session, wsTicket.ticket, options.scope);
    });

    const qboxEngine: InboxOutboxEngine = qbox.initialiseQBoxEngine();

    const webSocketQueueBox = await wsEngine.initialiseWsEngine(
        qboxEngine,
        socket,
        clientData,
        toResilienceDto(),
        {
            signal: options.signal,
            connectTimeoutMs: options.timeoutMs ??
                DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS.connectTimeoutMsecs,
            outboundDiagnostics: options.outboundDiagnostics,
        },
    )
        .catch((error) => {
            console.error('Failed to connect WebSocket client:', error);
            throw error;
        });

    const iceCandidates: IceConfig = await runMiddlewareCommand(
        (signal) => readIceCandidates({ signal }),
        options,
    );

    const webRtcConnectionService = await rtcEngine
        .initialiseRtcConnectionService(
            webSocketQueueBox,
            qboxEngine,
            clientData,
            iceCandidates,
            'rtc-data-channel',
            rtcSignalingTopicId,
            {
                dataChannelLanes: options.dataChannelLanes ??
                    [DEFAULT_REALTIME_DATA_CHANNEL_LANE],
                maxPeerConnections: options.maxPeerConnections,
            },
        );

    const webRtcOverlayMulticastManager = rtcEngine
        .initialiseRtcOverlayMulticastManager(
            webRtcConnectionService,
            qboxEngine,
            toResilienceDto(),
            {
                outboundDiagnostics: options.outboundDiagnostics,
            },
        );

    const rtcRxStreamer = rtcEngine.initialiseRtcRxStreamer(
        webRtcOverlayMulticastManager,
        qboxEngine,
        clientData,
        toResilienceDto(),
    );

    rtcRxStreamer.onRttMeasurementDo(
        AppTopics.rtt,
        {
            onHeartbeat: (rtt: RttMeasurementInfo): Promise<void> => {
                void webSocketQueueBox.enqueueOutboxIfAbsent(
                        toBrowserRttHeartbeatMessage(clientData.sessionId, rtt),
                    )
                    .then((result) => {
                        if (result.status === 'enqueued' || result.status === 'duplicate') {
                            qboxEngine.wake();
                        }
                    })
                    .catch((error) => {
                        console.error('Failed to enqueue RTT heartbeat', error);
                    });

                return Promise.resolve();
            },
        },
    );

    webRtcConnectionService
        .onRtcPeerLifecycleDo(
            'rtc-rx-streamer',
            {
                onCreated(peerDto: QRtcPeerDto) {
                    rtcRxStreamer.addPeer(peerDto);
                },
                onDeleted(peerDto: QRtcPeerDto) {
                    rtcRxStreamer.removePeer(peerDto);
                },
            },
        );

    const webRtcGroupManager = new WebRtcGroupManager(
        webRtcConnectionService,
        groupStateSnapshotsRepository.readableGroupStateSnapshotCache(),
        clientStateSnapshotsRepository.readableClientStateSnapshotCache(),
        overlaysRepository.readableOverlayCache(),
        {
            maxPeerConnections: options.maxPeerConnections,
            onDesiredPeerIdsChanged: refreshRttReportingPeers,
        },
    );

    function refreshRttReportingPeers(): void {
        rtcRxStreamer.setRttReportingPeerIds(
            webRtcGroupManager.rttReportingPeerIds({
                degreeLimit: options.rttReportingDegreeLimit,
            }),
        );
    }

    refreshRttReportingPeers();

    webRtcConnectionService.setInboundPeerCreationPolicy(({ peerId }) =>
        toBrowserRtcInboundPeerCreationDecision(
            webRtcGroupManager.isPeerOwnedByAnyGroup(peerId),
        )
    );

    cache.initialise(webSocketQueueBox, webRtcGroupManager, clientData, {
        scope: options.scope,
    });

    const {
        clients: clientSnapshots,
        groups: groupSnapshots,
    } = await refreshStateSnapshots(options.scope, {
        command: toCommandOptions(options),
    });

    await cache.hydrateStateCaches(
        webRtcGroupManager,
        clientData,
        clientSnapshots,
        groupSnapshots,
        { scope: options.scope },
    );

    const heartbeatHandle = await heartbeat.initHeartbeat(clientData, {
        authSession: session,
        scope: options.scope,
        onAuthInvalid: options.onAuthInvalid,
    });

    return {
        qboxEngine: qboxEngine,
        webSocketQueueBox: webSocketQueueBox,
        webRtcConnectionService: webRtcConnectionService,
        rtcRxStreamer: rtcRxStreamer,
        webRtcGroupManager: webRtcGroupManager,
        webRtcOverlayMulticastManager: webRtcOverlayMulticastManager,
        heartbeat: heartbeatHandle,
    };
}

function runMiddlewareCommand<T>(
    supplier: (signal?: AbortSignal) => T | Promise<T>,
    options: MiddlewareInitOptions,
): Promise<T> {
    return new Command<T>(supplier, toCommandOptions(options)).run();
}

function toCommandOptions<T>(
    options: MiddlewareInitOptions,
): CommandOptions<T> {
    return {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
    };
}
