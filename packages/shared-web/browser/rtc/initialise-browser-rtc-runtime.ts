import { toBrowserRtcOverlayALRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    createBrowserALVolatileOutboundRuntimeStores,
    resolveBrowserRtcOverlayALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import {
    AL_RTC_OVERLAY_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import type { ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALInboundRuntimeStores,
    ALVolatileInboundRuntimeStores
} from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundResyncRequired } from '@shared/alm/inbound/al-inbound-resync-required.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import type {
    ALCheckpointOutboundRuntimeStores,
    ALOutboundRuntimeDiagnosticsSink
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
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
import {
    disposeRtcNativeObservationScope,
    type RtcSignalingDiagnostics
} from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import { WsRtcSignalingTransportUsingWsQBox } from '@shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts';
import { createBrowserRtcCapture } from './create-browser-rtc-capture.ts';

export interface InitialiseRtcOverlayMulticastManagerInput {
    readonly qosProvider: ALQosInputProvider | undefined;
    readonly volatileBudget: ALVolatileSessionBudget;
    /** The connect's checkpoint pair of the RTC overlay, which its `local-checkpoint` admissions go to. */
    readonly checkpointStores: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
    readonly outboundSettlements: ALDeliverySettlementSink;
    readonly webRtcConnectionService: WebRtcConnectionService;
    readonly qboxEngine: InboxOutboxEngine;
    /** The connect's claim on its session's durable work, which only the durable lanes take. */
    readonly durableWorkOwnership: ALDurableWorkOwnership;
    readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
    /** The session's transport faults, the same port its data channels decide their frames by. */
    readonly faultPort: TransportFaultPort;
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
            stores,
            volatileStores: createBrowserALVolatileOutboundRuntimeStores(
                toBrowserRtcOverlayALRuntimeStoreId(webRtcConnectionService.input.sessionId),
                input.volatileBudget
            ),
            checkpointStores: input.checkpointStores,
            durableWorkOwnership: input.durableWorkOwnership
        }),
        dequeueResilience: createDefaultALOutboundDequeueResilience(),
        outboundDiagnostics: input.outboundDiagnostics,
        outboundSettlements: input.outboundSettlements,
        qosProvider: toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, input.qosProvider),
        circuitBreaker: toCircuitBreaker(),
        rateLimiter: toRateLimiter(),
        faultPort: input.faultPort
    });

    return webRtcOverlayMulticastManager;
}

export interface InitialiseRtcRxStreamerInput {
    readonly webRtcOverlayMulticastManager: WebRtcOverlayMulticastManager;
    readonly qboxEngine: InboxOutboxEngine;
    readonly clientData: ClientInfo;
    readonly inboundStores: ALInboundRuntimeStores;
    /** The session's inbound memory pair, the same one the WS client holds. */
    readonly inboundVolatileStores: ALVolatileInboundRuntimeStores;
    /** The connect's claim on its session's durable work, which only the durable lanes take. */
    readonly durableWorkOwnership: ALDurableWorkOwnership;
    readonly roomAuthorityRefresh?: WebRtcRxStreamerService.Input['roomAuthorityRefresh'];
    readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
    /** Absent, no recovery owner is told of a track this receiver can no longer order: a transport built without the messaging composition. */
    readonly onResyncRequired?: (resync: ALInboundResyncRequired) => void;
}

export function initialiseRtcRxStreamer(
    input: InitialiseRtcRxStreamerInput
): WebRtcRxStreamerService {
    const { webRtcOverlayMulticastManager, qboxEngine, clientData } = input;
    return createDefaultWebRtcRxStreamerService({
        queueEngine: qboxEngine,
        multicast: webRtcOverlayMulticastManager,
        sessionId: clientData.sessionId,
        inboundStores: input.inboundStores,
        inboundVolatileStores: input.inboundVolatileStores,
        nowEpochMs: Date.now,
        heartbeat: { maxMissedPings: defaultMaxMissedPings, pingFrequencyMsecs: defaultPingFrequencyMsecs },
        roomAuthorityRefresh: input.roomAuthorityRefresh,
        inboundDiagnostics: input.inboundDiagnostics,
        onResyncRequired: input.onResyncRequired,
        durableWorkOwnership: input.durableWorkOwnership
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
    readonly connectionId: RtcSignalingDiagnostics.Readout<string>;
    readonly rtcCaptureConfiguration: RtcSignalingDiagnostics.CaptureConfiguration;
    readonly signalingDiagnostics?: RtcSignalingDiagnostics['record'];
    readonly dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    readonly maxPeerConnections?: number;
}

export interface BrowserRtcConnectionInitialization {
    readonly webRtcConnectionService: WebRtcConnectionService;
    readonly rtcCaptureReceipt: RtcSignalingDiagnostics.CaptureReceipt;
}

export async function initialiseRtcConnectionService(
    input: InitialiseRtcConnectionServiceInput
): Promise<BrowserRtcConnectionInitialization> {
    const signaler = new WsRtcSignalingTransportUsingWsQBox(
        input.webSocketQueueBox,
        input.rtcSignalingTopicId,
        () => input.qboxEngine.wake()
    );
    const nowEpochMs = Date.now;
    const capture = createBrowserRtcCapture({
        configuration: input.rtcCaptureConfiguration,
        connectionId: input.connectionId,
        record: input.signalingDiagnostics,
        nowEpochMs
    });
    const dependencies = {
        faultPort: input.faultPort,
        createOfferId: () => crypto.randomUUID(),
        nowEpochMs,
        signalingDiagnostics: capture.diagnostics
    };
    try {
        const connectionService = new WebRtcConnectionService(
            signaler,
            toBrowserRtcConnectionServiceInput(input),
            dependencies
        );

        connectionService.setInboundPeerCreationPolicy(() => ({
            decision: 'retry',
            reason: 'browser-runtime-initializing'
        }));
        connectionService.setOutboundDialPolicy(() => ({
            decision: 'deny',
            reason: 'browser-runtime-initializing'
        }));
        await connectionService.connectSignaler();

        return { webRtcConnectionService: connectionService, rtcCaptureReceipt: capture.receipt };
    }
    catch (caught) {
        disposeRtcNativeObservationScope(capture.diagnostics, input.clientData.sessionId);
        throw caught;
    }
}

function toBrowserRtcConnectionServiceInput(
    input: InitialiseRtcConnectionServiceInput
): WebRtcConnectionService.InputDto {
    return {
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
    };
}
