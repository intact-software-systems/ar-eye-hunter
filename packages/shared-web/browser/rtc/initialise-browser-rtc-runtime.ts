import {
    resolveBrowserRtcOverlayALOutboundRuntimeStores,
    resolveBrowserRtcRxALInboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { createBrowserQueueBox } from '@shared-web/browser/queuebox/browser-queuebox-persistence.ts';
import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createDefaultALOutboundRuntimeResources } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type {
    ClientInfo,
    IceConfig,
    OverlayId
} from '@shared/api/api-config.ts';
import type { WebRtcOverlayMulticaster } from '@shared/multicast/overlay-multicast-contracts.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import type { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
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
import { WsRtcSignalingTransportUsingWsQBox } from '@shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts';

export interface InitialiseRtcOverlayMulticastManagerInput {
    readonly webRtcConnectionService: WebRtcConnectionService;
    readonly qboxEngine: InboxOutboxEngine;
    readonly resilience: ResourceInboxResilience;
    readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
}

export function initialiseRtcOverlayMulticastManager(
    input: InitialiseRtcOverlayMulticastManagerInput
) {
    const { webRtcConnectionService, qboxEngine, resilience } = input;
    const webRtcOverlayMulticastManager = new WebRtcOverlayMulticastManager({
        outbox: createBrowserQueueBox(`rtc-overlay-outbox-${webRtcConnectionService.input.sessionId}`),
        connectionService: webRtcConnectionService,
        groupCache: groupStateSnapshotsRepository.readableGroupStateSnapshotCache(),
        overlayCache: overlaysRepository.readableAcceptedOverlayCache(),
        multicasterFactory: (overlayId: OverlayId): WebRtcOverlayMulticaster =>
            new WebRtcOverlayMulticastService(overlayId, webRtcConnectionService),
        outboundRuntime: createDefaultALOutboundRuntimeResources({
            queueEngine: qboxEngine,
            stores: resolveBrowserRtcOverlayALOutboundRuntimeStores(webRtcConnectionService.input.sessionId)
        }),
        outboundDiagnostics: input.outboundDiagnostics,
        qosProvider: undefined,
        circuitBreaker: toCircuitBreaker(),
        rateLimiter: toRateLimiter()
    });

    qboxEngine.includeTask(
        WebRtcOverlayMulticastManager.ENQUEUE_TYPE,
        {
            name: WebRtcOverlayMulticastManager.ENQUEUE_TYPE,
            maxConcurrency: () => 1,
            isWork: () =>
                webRtcOverlayMulticastManager
                    .outbox
                    .isAnyEntryToLock(
                        WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES,
                        resilience.toWorkAdvertisementOptions()
                    ),
            runnable: () =>
                webRtcOverlayMulticastManager.dequeue(
                    WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES,
                    resilience
                ),
            ongoingTasks: []
        }
    );

    return webRtcOverlayMulticastManager;
}

export interface InitialiseRtcRxStreamerInput {
    readonly webRtcOverlayMulticastManager: WebRtcOverlayMulticastManager;
    readonly qboxEngine: InboxOutboxEngine;
    readonly clientData: ClientInfo;
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
        heartbeat: { maxMissedPings: defaultMaxMissedPings, pingFrequencyMsecs: defaultPingFrequencyMsecs }
    });
}

export interface InitialiseRtcConnectionServiceInput {
    readonly webSocketQueueBox: WsQueueBoxClientService;
    readonly qboxEngine: InboxOutboxEngine;
    readonly clientData: ClientInfo;
    readonly iceCandidates: IceConfig;
    readonly dataChannelName: string;
    readonly rtcSignalingTopicId: string;
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
            maxPeerConnections: input.maxPeerConnections
        }
    );

    const denyUntilGroupManagerReady = (): WebRtcConnectionService.PeerCreationDecision => ({
        decision: 'deny',
        reason: 'browser-runtime-initializing'
    });
    rtcQBox.setInboundPeerCreationPolicy(denyUntilGroupManagerReady);
    rtcQBox.setOutboundDialPolicy(denyUntilGroupManagerReady);
    await rtcQBox.connectSignaler();

    return rtcQBox;
}
