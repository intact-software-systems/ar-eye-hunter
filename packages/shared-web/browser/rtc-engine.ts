import {
    resolveBrowserRtcOverlayALOutboundRuntimeStores,
    resolveBrowserRtcRxALInboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { createBrowserQueueBox } from '@shared-web/browser/queuebox/browser-queuebox-persistence.ts';
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

export interface InitialiseRtcOverlayMulticastManagerInput {
    readonly webRtcConnectionService: WebRtcConnectionService;
    readonly qboxEngine: InboxOutboxEngine;
    readonly resilience: ResilienceDto;
    readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
}

export function initialiseRtcOverlayMulticastManager(
    input: InitialiseRtcOverlayMulticastManagerInput
) {
    const { webRtcConnectionService, qboxEngine, resilience } = input;
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
            outboundDiagnostics: input.outboundDiagnostics
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

export interface InitialiseRtcRxStreamerInput {
    readonly webRtcOverlayMulticastManager: WebRtcOverlayMulticastManager;
    readonly qboxEngine: InboxOutboxEngine;
    readonly clientData: ClientInfo;
    readonly resilience: ResilienceDto;
}

export function initialiseRtcRxStreamer(
    input: InitialiseRtcRxStreamerInput
): WebRtcRxStreamerService {
    const { webRtcOverlayMulticastManager, qboxEngine, clientData, resilience } = input;
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

    await rtcQBox.connectSignaler();

    return rtcQBox;
}
