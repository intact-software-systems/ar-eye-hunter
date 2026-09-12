import {
    resolveBrowserRtcOverlayALOutboundRuntimeStores,
    resolveBrowserRtcRxALInboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type {
    ClientInfo,
    IceConfig,
    OverlayId
} from '@shared/api/api-config.ts';
import type { WebRtcOverlayMulticaster } from '@shared/multicast/overlay-multicast-contracts.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import type { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import {
    DEFAULT_WEB_RTC_PEER_CONNECTION_ATTEMPT_BUDGET_POLICY,
    DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY,
    WebRtcConnectionService,
    type RtcDataChannelLaneConfig
} from '@shared/services/web-rtc-connection-service.ts';
import { defaultMaxMissedPings, defaultPingFrequencyMsecs } from '@shared/services/web-rtc-heartbeat-service.ts';
import {
    createDefaultWebRtcRxStreamerService,
    WebRtcRxStreamerService
} from '@shared/services/web-rtc-rx-streamer-service.ts';
import type { WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import type { TransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { WsRtcSignalingTransportUsingWsQBox } from '@shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts';

export interface InitialiseRtcOverlayMulticastManagerInput {
    readonly webRtcConnectionService: WebRtcConnectionService;
    readonly qboxEngine: InboxOutboxEngine;
    readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
}

export function initialiseRtcOverlayMulticastManager(
    input: InitialiseRtcOverlayMulticastManagerInput
) {
    const { webRtcConnectionService, qboxEngine } = input;
    const stores = resolveBrowserRtcOverlayALOutboundRuntimeStores(webRtcConnectionService.input.sessionId);
    const webRtcOverlayMulticastManager = new WebRtcOverlayMulticastManager({
        connectionService: webRtcConnectionService,
        groupCache: groupStateSnapshotsRepository.readableGroupStateSnapshotCache(),
        overlayCache: overlaysRepository.readableAcceptedOverlayCache(),
        multicasterFactory: (overlayId: OverlayId): WebRtcOverlayMulticaster =>
            new WebRtcOverlayMulticastService(overlayId, webRtcConnectionService),
        outboundRuntime: createDefaultALOutboundRuntimeResources({
            decodePrepared: decodeALOutboundTransportMessage,
            queueEngine: qboxEngine,
            stores
        }),
        dequeueResilience: createDefaultALOutboundDequeueResilience(),
        outboundDiagnostics: input.outboundDiagnostics,
        qosProvider: undefined,
        circuitBreaker: toCircuitBreaker(),
        rateLimiter: toRateLimiter()
    });

    return webRtcOverlayMulticastManager;
}

export interface InitialiseRtcRxStreamerInput {
    readonly webRtcOverlayMulticastManager: WebRtcOverlayMulticastManager;
    readonly qboxEngine: InboxOutboxEngine;
    readonly clientData: ClientInfo;
    readonly roomAuthorityRefresh?: WebRtcRxStreamerService.Input['roomAuthorityRefresh'];
    readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
}

export function initialiseRtcRxStreamer(
    input: InitialiseRtcRxStreamerInput
): WebRtcRxStreamerService {
    const { webRtcOverlayMulticastManager, qboxEngine, clientData } = input;
    return createDefaultWebRtcRxStreamerService({
        queueEngine: qboxEngine,
        multicast: webRtcOverlayMulticastManager,
        sessionId: clientData.sessionId,
        inboundStores: resolveBrowserRtcRxALInboundRuntimeStores(clientData.sessionId),
        nowEpochMs: Date.now,
        heartbeat: { maxMissedPings: defaultMaxMissedPings, pingFrequencyMsecs: defaultPingFrequencyMsecs },
        roomAuthorityRefresh: input.roomAuthorityRefresh,
        inboundDiagnostics: input.inboundDiagnostics
    });
}

export interface InitialiseRtcConnectionServiceInput {
    readonly webSocketQueueBox: WsQueueBoxClientService;
    readonly qboxEngine: InboxOutboxEngine;
    readonly clientData: ClientInfo;
    readonly iceCandidates: IceConfig;
    readonly dataChannelName: string;
    readonly rtcSignalingTopicId: string;
    readonly faultPort: TransportFaultPort;
    readonly dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    readonly maxPeerConnections?: number;
}

export async function initialiseRtcConnectionService(
    input: InitialiseRtcConnectionServiceInput
): Promise<WebRtcConnectionService> {
    const rtcQBox = new WebRtcConnectionService(
        new WsRtcSignalingTransportUsingWsQBox(
            input.webSocketQueueBox,
            input.rtcSignalingTopicId,
            () => input.qboxEngine.wake()
        ),
        {
            sessionId: input.clientData.sessionId,
            token: 'NOT_CREATED_YET',
            iceCandidates: input.iceCandidates,
            dataChannelName: input.dataChannelName,
            dataChannelLanes: input.dataChannelLanes,
            rtcSignalingTopicId: input.rtcSignalingTopicId,
            peerEstablishmentTimeout: {
                ...DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY,
                enabled: true
            },
            peerConnectionAttemptBudget: {
                ...DEFAULT_WEB_RTC_PEER_CONNECTION_ATTEMPT_BUDGET_POLICY,
                enabled: true
            },
            maxPeerConnections: input.maxPeerConnections,
            faultPort: input.faultPort
        },
        { createOfferId: () => crypto.randomUUID() }
    );

    rtcQBox.setInboundPeerCreationPolicy(() => ({
        decision: 'retry',
        reason: 'browser-runtime-initializing'
    }));
    rtcQBox.setOutboundDialPolicy(() => ({
        decision: 'deny',
        reason: 'browser-runtime-initializing'
    }));
    await rtcQBox.connectSignaler();

    return rtcQBox;
}
