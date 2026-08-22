import {
    resolveBrowserRtcOverlayALOutboundRuntimeStores,
    resolveBrowserRtcRxALInboundRuntimeStores
} from '@shared-web/browser/browser-al-runtime-stores.ts';
import { createBrowserQueueBox } from '@shared-web/browser/browser-queuebox.ts';
import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/ALOutboundMessageRuntime.ts';
import { ClientInfo, IceConfig, OverlayId } from '@shared/api/api-config.ts';
import { WebRtcOverlayMulticaster } from '@shared/multicast/OverlayMulticastContracts.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/WebRtcOverlayMulticastManager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/WebRtcOverlayMulticastService.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import {
    DEFAULT_WEB_RTC_PEER_CONNECTION_ATTEMPT_BUDGET_POLICY,
    DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY,
    WebRtcConnectionService,
    type RtcDataChannelLaneConfig
} from '@shared/services/WebRtcConnectionService.ts';
import { WebRtcRxStreamerService } from '@shared/services/WebRtcRxStreamerService.ts';
import { WsQueueBoxClientService } from '@shared/services/WsQueueBoxClientService.ts';
import { WsRtcSignalingTransportUsingWsQBox } from '@shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts';

export function initialiseRtcOverlayMulticastManager(
    webRtcConnectionService: WebRtcConnectionService,
    qboxEngine: InboxOutboxEngine,
    resilience: ResilienceDto,
    options: Readonly<{
        outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
    }> = {}
) {
    const webRtcOverlayMulticastManager: WebRtcOverlayMulticastManager = new WebRtcOverlayMulticastManager(
        createBrowserQueueBox(`rtc-overlay-outbox-${webRtcConnectionService.input.sessionId}`),
        webRtcConnectionService,
        groupStateSnapshotsRepository.readableGroupStateSnapshotCache(),
        overlaysRepository.readableOverlayCache(),
        (overlayId: OverlayId): WebRtcOverlayMulticaster =>
            new WebRtcOverlayMulticastService(overlayId, webRtcConnectionService),
        {
            outboundStores: resolveBrowserRtcOverlayALOutboundRuntimeStores(
                webRtcConnectionService.input.sessionId
            ),
            outboundDiagnostics: options.outboundDiagnostics
        }
    );

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

export function initialiseRtcRxStreamer(
    webRtcOverlayMulticastManager: WebRtcOverlayMulticastManager,
    qboxEngine: InboxOutboxEngine,
    clientData: ClientInfo,
    resilience: ResilienceDto
): WebRtcRxStreamerService {
    const rtcRxStreamer: WebRtcRxStreamerService = new WebRtcRxStreamerService(
        createBrowserQueueBox(`rtc-inbox-${clientData.sessionId}`),
        webRtcOverlayMulticastManager,
        {
            sessionId: clientData.sessionId
        },
        {
            inboundStores: resolveBrowserRtcRxALInboundRuntimeStores(clientData.sessionId)
        }
    )
        .enableDefaultCallbacks();

    qboxEngine.includeTask(
        WebRtcRxStreamerService.ENQUEUE_TYPE,
        {
            name: WebRtcRxStreamerService.ENQUEUE_TYPE,
            maxConcurrency: () => 1,
            isWork: () =>
                rtcRxStreamer
                    .inbox
                    .isAnyEntryToLock(
                        WebRtcRxStreamerService.INBOX_DEQUEUE_TYPES,
                        resilience.toWorkAdvertisementOptions()
                    ),
            runnable: () => rtcRxStreamer.dequeueInbox(WebRtcRxStreamerService.INBOX_DEQUEUE_TYPES, resilience),
            ongoingTasks: []
        }
    );

    return rtcRxStreamer;
}

export async function initialiseRtcConnectionService(
    webSocketQueueBox: WsQueueBoxClientService,
    qboxEngine: InboxOutboxEngine,
    clientData: ClientInfo,
    iceCandidates: IceConfig,
    dataChannelName: string,
    rtcSignalingTopicId: string,
    options: Readonly<{
        dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
        maxPeerConnections?: number;
    }> = {}
): Promise<WebRtcConnectionService> {
    const rtcQBox = new WebRtcConnectionService(
        new WsRtcSignalingTransportUsingWsQBox(
            webSocketQueueBox,
            rtcSignalingTopicId,
            () => qboxEngine.wake()
        ),
        {
            sessionId: clientData.sessionId,
            token: 'NOT_CREATED_YET',
            iceCandidates: iceCandidates,
            dataChannelName: dataChannelName,
            dataChannelLanes: options.dataChannelLanes,
            rtcSignalingTopicId: rtcSignalingTopicId,
            peerEstablishmentTimeout: {
                ...DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY,
                enabled: true
            },
            peerConnectionAttemptBudget: {
                ...DEFAULT_WEB_RTC_PEER_CONNECTION_ATTEMPT_BUDGET_POLICY,
                enabled: true
            },
            maxPeerConnections: options.maxPeerConnections
        }
    );

    await rtcQBox.connectSignaler();

    return rtcQBox;
}
