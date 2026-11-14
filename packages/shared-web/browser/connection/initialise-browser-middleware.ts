import {
    resolveBrowserALCheckpointStores,
    type BrowserALCheckpointStores
} from '@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts';
import { initBrowserALRuntimeExpiryEviction } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import { toBrowserSessionALInboundRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    configureBrowserALRuntimeStores,
    createBrowserALVolatileInboundRuntimeStores,
    resolveBrowserSessionALInboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import type { BrowserALStorageAvailability } from '@shared-web/browser/al-runtime/browser-al-storage-availability.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { createWebSocketTicket } from '@shared-web/browser/auth/websocket-ticket-http-api.ts';
import { BrowserInboundOrderingCountersSink } from '@shared-web/browser/connection/browser-inbound-ordering-counters-sink.ts';
import { BrowserOwnWsConnectionGeneration } from '@shared-web/browser/connection/browser-own-ws-connection-generation.ts';
import { readApiConfig } from '@shared-web/browser/connection/connection-http-api.ts';
import {
    createBrowserSessionVolatileBound,
    type BrowserSessionVolatileBound
} from '@shared-web/browser/connection/create-browser-session-volatile-bound.ts';
import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { createBrowserQueueBoxEngine } from '@shared-web/browser/queuebox/create-browser-queue-box-engine.ts';
import type { RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { DEFAULT_REALTIME_DATA_CHANNEL_LANE } from '@shared-web/browser/rallar-realtime-facade.ts';
import * as rtcEngine from '@shared-web/browser/rtc/initialise-browser-rtc-runtime.ts';
import * as heartbeat from '@shared-web/browser/session/browser-session-heartbeat.ts';
import { initialiseBrowserCacheRepositories } from '@shared-web/browser/state-cache/initialise-browser-cache-repositories.ts';
import {
    acceptAuthoritativeGroupSessionLeaseAdvance,
    acceptAuthoritativeGroupStateSnapshot
} from '@shared-web/browser/state-cache/state-cache-snapshot-adoption.ts';
import { initGroupStateResyncOnReopen } from '@shared-web/browser/state-read/group-state-resync-on-reopen.ts';
import { hydrateGroupTopologyOverlays } from '@shared-web/browser/state-read/hydrate-group-topology-overlays.ts';
import { readStateClientSnapshot, readStateGroupSnapshot } from '@shared-web/browser/state-read/point-read.ts';
import { refreshStateSnapshots, type StateSnapshots } from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import { RtcGroupSnapshotRefresh } from '@shared-web/browser/state-read/rtc-group-snapshot-refresh.ts';
import { listStateGroups } from '@shared-web/browser/state-read/state-snapshot-http-api.ts';
import {
    createBrowserWebSocketQueueBox,
    type CreateBrowserWebSocketQueueBox
} from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
import {
    newALRoute,
    newALUntargetedMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import type { ALPublicationStageLimits } from '@shared/al-contracts/publication/al-publication-stage-limits.ts';
import type { ALCheckpointPort } from '@shared/alm/checkpoint/al-checkpoint.ts';
import type {
    ALInboundRuntimeStores,
    ALVolatileInboundRuntimeStores
} from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundResyncRequired } from '@shared/alm/inbound/al-inbound-resync-required.ts';
import { ALRuntimeStorage } from '@shared/alm/storage/al-runtime-storage.ts';
import type { ALVolatileSessionLimits } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
import type {
    ApiConfig,
    ApiConfigResponse,
    AuthSession,
    ClientInfo,
    IceConfig,
    RttMeasurementInfo
} from '@shared/api/api-config.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import { readSession } from '@shared/api/auth.ts';
import { validateAuthoritativeGroupSnapshotList } from '@shared/api/authoritative-state-validation.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command, type CommandOptions } from '@shared/cache/Command.ts';
import type { RtcGrantedTopicReader } from '@shared/multicast/publication/rtc-granted-topic-reader.ts';
import type { RtcPublicationProofVerifierPort } from '@shared/multicast/publication/rtc-publication-proof-verifier-port.ts';
import type { RtcTopicSubscriptionReader } from '@shared/multicast/publication/rtc-topic-subscription-reader.ts';
import type { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import { pairKey } from '@shared/repository/rtt-repository.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { resolveBootstrapDegree } from '@shared/rtc/bootstrap-peer-selection.ts';
import type { ConnectionCapInboundVerdict } from '@shared/services/group-dial/compute-connection-cap-spend.ts';
import type { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import type { RtcDataChannelLaneConfig, WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import type { WebRtcRxStreamerService } from '@shared/services/web-rtc-rx-streamer-service.ts';
import type { WebRtcGroupManagerOptions } from '@shared/services/webrtc-group-manager-contracts.ts';
import type { WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS } from '@shared/services/ws-queue-box-client-service.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import { JsonWebSocketClient, type WebSocketConnectOptions } from '@shared/websocket/json-web-socket-client.ts';
import { toApiWsUrl } from '@shared/websocket/to-api-ws-url.ts';
import {
    closeBrowserTransportResources,
    reportBrowserStartupCleanupFailure
} from './close-browser-transport-resources.ts';
import { toBrowserHeartbeatOptions } from './to-browser-heartbeat-options.ts';

import {
    browserStateCacheLifecycle,
    type StateCacheScopeOptions
} from '../state-cache/browser-state-cache-lifecycle.ts';
import type { BrowserDeliverySettlements } from './browser-delivery-settlements.ts';

export interface MiddlewareInitOptions {
    readonly rtcCaptureConfiguration: RtcSignalingDiagnostics.CaptureConfiguration;
    readonly qosProvider: ALQosInputProvider;
    readonly readVolatileSessionLimits: () => ALVolatileSessionLimits;
    /** Read once per connect, as the volatile limits are. */
    readonly readPublicationStageLimits: () => ALPublicationStageLimits;
    readonly deliverySettlements: BrowserDeliverySettlements.Carriers;
    readonly diagnosticsPorts: RallarDiagnosticsPorts;
    /** Where both carriers' inbound runtimes hand a message they can no longer order. */
    readonly onResyncRequired: (resync: ALInboundResyncRequired) => void;
    /** The key pair of the session this connect connects, read for it by the session controller; awaited once. */
    readonly publicationCrypto: Promise<PublicationCrypto>;
    /** Built once per page over its WebCrypto; each connect's RTC overlay verifies granted frames with it. */
    readonly publicationVerifier: RtcPublicationProofVerifierPort;
    /** The page's granted topics, whose RTC publications the overlay signs with the page's key. */
    readonly grantedTopics: RtcGrantedTopicReader;
    /** The tab's held subscription tokens, which a granted RTC frame's local delivery reads. */
    readonly topicSubscriptions: RtcTopicSubscriptionReader;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    readonly maxPeerConnections?: number;
    readonly rttReportingDegreeLimit?: number;
    readonly bootstrapDegree?: number;
    readonly scope?: StateScope;
    readonly onAuthInvalid?: (error: Error) => void | Promise<void>;
}

/** One connect's options: the caller's, and the connect's claim on its session's durable work. */
export interface BrowserConnectOptions extends MiddlewareInitOptions {
    readonly durableWorkOwnership: ALDurableWorkOwnership;
    readIceCandidates(signal?: AbortSignal): Promise<IceConfig>;
}

/** One connect's middleware, and the checkpoints of its two carriers, which the connect's page lifecycle flushes. */
export interface BrowserConnectedMiddleware {
    readonly rtcCaptureReceipt: RtcSignalingDiagnostics.CaptureReceipt;
    readonly middleware: RallarBrowserMiddleware;
    readonly checkpoints: readonly ALCheckpointPort[];
}

export const BROWSER_RTT_HEARTBEAT_TTL_MS = 15_000;

export type BrowserWebSocketCarrier = Pick<
    CreateBrowserWebSocketQueueBox.Input,
    'qboxEngine' | 'socket' | 'serverPeerId'
>;

export type BrowserRtcOverlayCarrier = Pick<
    rtcEngine.InitialiseRtcOverlayMulticastManagerInput,
    'webRtcConnectionService' | 'qboxEngine' | 'replacedLayoutOverlapMs'
>;

export interface BrowserMiddlewareCreation {
    readonly createMessage: typeof newALUntargetedMessage;
    newConnectionRequestId(): string;
}

/** The heartbeat registration needs only the active session and live WS sender. */
export interface BrowserRttEgressInput {
    readonly webSocketTransport: Pick<BrowserWebSocketTransport, 'webSocketQueueBox'>;
    readonly clientData: Pick<ClientInfo, 'sessionId'>;
    readonly creation: Pick<BrowserMiddlewareCreation, 'createMessage'>;
}

export interface InitialiseBrowserTransportInput {
    readonly connectionId: RtcSignalingDiagnostics.Readout<string>;
    readonly creation: BrowserMiddlewareCreation;
    readonly session: AuthSession;
    readonly clientData: ClientInfo;
    readonly inboundStores: ALInboundRuntimeStores;
    readonly inboundVolatileStores: ALVolatileInboundRuntimeStores;
    readonly volatileBound: BrowserSessionVolatileBound;
    /** Built once per connect over the session's port; both carriers' runtimes report through it. */
    readonly inboundOrderingCounters: BrowserInboundOrderingCountersSink;
    readonly publicationStageLimits: ALPublicationStageLimits;
    /** Built once per connect, under its claim; the WS client and the RTC overlay each take their own. */
    readonly checkpointStores: BrowserALCheckpointStores;
    /** The session's one key, which each group heartbeat registers and the RTC overlay signs with. */
    readonly publicationCrypto: PublicationCrypto;
    readonly publicationVerifier: RtcPublicationProofVerifierPort;
    readonly options: BrowserConnectOptions;
}

/** The connect's publication capabilities: its session's key, awaited once, and the page's verifier. */
export type BrowserTransportPublication = Pick<
    InitialiseBrowserTransportInput,
    'publicationCrypto' | 'publicationVerifier'
>;

interface BrowserWebSocketTransport {
    readonly qboxEngine: InboxOutboxEngine;
    readonly webSocketQueueBox: WsQueueBoxClientService;
}

interface BrowserRtcTransport {
    readonly rtcCaptureReceipt: RtcSignalingDiagnostics.CaptureReceipt;
    readonly webRtcConnectionService: WebRtcConnectionService;
    readonly rtcRxStreamer: WebRtcRxStreamerService;
    readonly webRtcGroupManager: WebRtcGroupManager;
    readonly webRtcOverlayMulticastManager: WebRtcOverlayMulticastManager;
}

interface BrowserTransports {
    readonly webSocketTransport: BrowserWebSocketTransport;
    readonly rtcTransport: BrowserRtcTransport;
}

/** Only successfully acquired RTC owners enter startup rollback; construction fills this journal. */
interface BrowserRtcAcquisitions {
    readonly webRtcConnectionService: WebRtcConnectionService;
    webRtcOverlayMulticastManager?: WebRtcOverlayMulticastManager;
    rtcRxStreamer?: WebRtcRxStreamerService;
    webRtcGroupManager?: WebRtcGroupManager;
}

interface InitialiseBrowserRtcTransportInput extends InitialiseBrowserTransportInput {
    readonly rtcSignalingTopicId: string;
    readonly webSocketTransport: BrowserWebSocketTransport;
    readonly replacedLayoutOverlapMs: number;
}

interface InitialiseBrowserStateTransportInput extends InitialiseBrowserTransportInput {
    readonly webSocketQueueBox: WsQueueBoxClientService;
    readonly webRtcGroupManager: WebRtcGroupManager;
    readonly bootstrapDegree: number;
}

interface BrowserRtcGroupSnapshotRequest {
    readonly roomRef: GroupRef;
    readonly minSnapshotVersion: number;
    readonly signal: AbortSignal;
}

export function createBrowserRttHeartbeatMessage(
    sessionId: string,
    rtt: RttMeasurementInfo,
    createMessage: typeof newALUntargetedMessage
): ALMessage {
    return createMessage<RttMeasurementInfo>(
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

/** Why a peer is refused until this browser adopts the layout that names it; adoption releases its held offers. */
export const BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON = 'stage-layout-mismatch';
/**
 * Why an early-dial peer's offer waits: no connection slot is free for it. The end of every reconcile pass releases
 * these holds, so a slot freed by a closed peer or an ended grace admits the held offer at once.
 */
const BROWSER_RTC_EARLY_DIAL_CAPACITY_REASON = 'early-dial-capacity';

export function configureBrowserRtcPeerCreationPolicies(
    webRtcConnectionService: WebRtcConnectionService,
    webRtcGroupManager: WebRtcGroupManager
): void {
    webRtcConnectionService.setInboundPeerCreationPolicy(({ peerId }) =>
        webRtcGroupManager.isPeerDialAllowedByAnyGroup(peerId)
            ? toInboundPeerCreationDecision(webRtcGroupManager.admitInboundPeer(peerId))
            : { decision: 'retry', reason: BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON }
    );
    webRtcConnectionService.setInboundPeerCapPolicy({
        decide: ({ peerId }) => toPeerCapDecision(webRtcGroupManager, peerId),
        wouldAdmit: ({ peerId }) =>
            webRtcGroupManager.isPeerDialAllowedByAnyGroup(peerId) &&
            webRtcGroupManager.resolveInboundPeer(peerId) === 'admitted'
    });
    webRtcConnectionService.setOutboundDialPolicy(({ peerId }) =>
        webRtcGroupManager.isPeerDialAllowedByAnyGroup(peerId)
            ? { decision: 'allow' }
            : { decision: 'deny', reason: BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON }
    );
}

/**
 * A peer no room dials yet is held while an early peer could make room for it, so the adoption that names it releases
 * it; with no early peer it is refused. Nothing closes while it is held.
 */
function toPeerCapDecision(
    webRtcGroupManager: WebRtcGroupManager,
    peerId: string
): WebRtcConnectionService.InboundPeerCreationDecision {
    if (webRtcGroupManager.isPeerDialAllowedByAnyGroup(peerId)) {
        return toInboundPeerCreationDecision(webRtcGroupManager.admitInboundPeer(peerId));
    }
    return webRtcGroupManager.hasClosableEarlyPeer()
        ? { decision: 'retry', reason: BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON }
        : { decision: 'deny', reason: BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON };
}

export function createBrowserRtcHeldOfferReleases(
    webRtcConnectionService: WebRtcConnectionService
): Pick<WebRtcGroupManagerOptions, 'onOverlayAdopted' | 'onReconcilePassEnded'> {
    return {
        onReconcilePassEnded: () => releaseEarlyDialCapacityHolds(webRtcConnectionService),
        onOverlayAdopted: () =>
            webRtcConnectionService.writeHeldInboundSignalsDueNow(BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON)
    };
}

function releaseEarlyDialCapacityHolds(webRtcConnectionService: WebRtcConnectionService): void {
    void webRtcConnectionService.writeHeldInboundSignalsDueNow(BROWSER_RTC_EARLY_DIAL_CAPACITY_REASON)
        .catch((caught) => console.error('Failed to release early-dial offers held for a slot', toError(caught)));
}

function toInboundPeerCreationDecision(
    verdict: ConnectionCapInboundVerdict
): WebRtcConnectionService.InboundPeerCreationDecision {
    switch (verdict) {
        case 'admitted':
            return { decision: 'allow' };
        case 'held':
            return { decision: 'retry', reason: BROWSER_RTC_EARLY_DIAL_CAPACITY_REASON };
        case 'refused':
            return { decision: 'deny', reason: 'max-peer-connections' };
    }
}

export async function initialiseMiddleware(
    session: AuthSession,
    rtcSignalingTopicId: string,
    options: BrowserConnectOptions
): Promise<BrowserConnectedMiddleware> {
    const runtimeStorage = new ALRuntimeStorage();
    let transports: BrowserTransports | undefined;
    try {
        const storageAvailability = initialiseBrowserRuntimeStores(
            session.sessionId,
            options.scope ?? defaultStateScope(),
            { diagnosticsPorts: options.diagnosticsPorts, runtimeStorage }
        );
        const transportInput = createBrowserTransportInput(session, options, {
            publicationCrypto: await options.publicationCrypto,
            publicationVerifier: options.publicationVerifier
        });
        const apiConfig = await runMiddlewareCommand((signal) => readApiConfig({ signal }), options);
        transports = await initialiseBrowserTransports(transportInput, rtcSignalingTopicId, apiConfig);
        const { webSocketTransport, rtcTransport } = transports;
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
        const ownWsConnectionGeneration = createBrowserOwnWsConnectionGeneration(
            session,
            options.scope ?? defaultStateScope(),
            webSocketTransport.webSocketQueueBox
        );
        const heartbeatHandle = await initialiseBrowserHeartbeat(transportInput, ownWsConnectionGeneration);
        const { checkpointStores } = transportInput;
        return {
            rtcCaptureReceipt: rtcTransport.rtcCaptureReceipt,
            middleware: toBrowserMiddleware(transportInput, {
                ...webSocketTransport,
                ...rtcTransport,
                heartbeat: heartbeatHandle,
                ownWsConnectionGeneration,
                runtimeStorage,
                storageAvailability
            }),
            checkpoints: [checkpointStores.wsClient.checkpoint, checkpointStores.rtcOverlay.checkpoint]
        };
    }
    catch (caught) {
        await closeBrowserTransportResources({
            ...transports?.webSocketTransport,
            ...transports?.rtcTransport,
            runtimeStorage
        })
            .catch((failure) => reportBrowserStartupCleanupFailure(toError(failure)));
        throw caught;
    }
}

async function initialiseBrowserTransports(
    transportInput: InitialiseBrowserTransportInput,
    rtcSignalingTopicId: string,
    apiConfig: ApiConfigResponse
): Promise<BrowserTransports> {
    const webSocketTransport = await initialiseBrowserWebSocketTransport(transportInput, apiConfig);
    try {
        const rtcTransport = await initialiseBrowserRtcTransport({
            ...transportInput,
            rtcSignalingTopicId,
            webSocketTransport,
            replacedLayoutOverlapMs: apiConfig.rtcReplacedLayoutOverlapMs
        });
        return { webSocketTransport, rtcTransport };
    }
    catch (caught) {
        await closeBrowserTransportResources(webSocketTransport)
            .catch((failure) => reportBrowserStartupCleanupFailure(toError(failure)));
        throw caught;
    }
}

export function createBrowserTransportInput(
    session: AuthSession,
    options: BrowserConnectOptions,
    publication: BrowserTransportPublication
): InitialiseBrowserTransportInput {
    const clientData: ClientInfo = {
        clientId: session.clientId,
        sessionId: session.sessionId,
        isOnline: true
    };
    const volatileBound = createBrowserSessionVolatileBound({
        readVolatileSessionLimits: options.readVolatileSessionLimits,
        qosProvider: options.qosProvider,
        nowMs: Date.now
    });
    return {
        connectionId: readBrowserConnectionIdentity(),
        session,
        clientData,
        inboundStores: resolveBrowserSessionALInboundRuntimeStores(clientData.sessionId),
        inboundVolatileStores: createBrowserALVolatileInboundRuntimeStores(
            toBrowserSessionALInboundRuntimeStoreId(clientData.sessionId),
            volatileBound.budget,
            options.diagnosticsPorts.storage
        ),
        volatileBound,
        inboundOrderingCounters: new BrowserInboundOrderingCountersSink(options.diagnosticsPorts.inboundDiagnostics),
        publicationStageLimits: options.readPublicationStageLimits(),
        checkpointStores: resolveBrowserALCheckpointStores(clientData.sessionId, options.durableWorkOwnership),
        ...publication,
        options,
        creation: {
            createMessage: newALUntargetedMessage,
            newConnectionRequestId: crypto.randomUUID.bind(crypto)
        }
    };
}

export function registerBrowserRttEgress(
    input: BrowserRttEgressInput,
    rtcRxStreamer: Pick<WebRtcRxStreamerService, 'onRttMeasurementDo'>
): void {
    rtcRxStreamer.onRttMeasurementDo(AppTopics.rtt, {
        onHeartbeat: (rtt: RttMeasurementInfo): Promise<void> => {
            input.webSocketTransport.webSocketQueueBox.sendLive(
                createBrowserRttHeartbeatMessage(input.clientData.sessionId, rtt, input.creation.createMessage)
            );
            return Promise.resolve();
        }
    });
}

function createBrowserOwnWsConnectionGeneration(
    session: AuthSession,
    socketScope: StateScope,
    webSocketQueueBox: WsQueueBoxClientService
): BrowserOwnWsConnectionGeneration {
    return new BrowserOwnWsConnectionGeneration({
        socket: webSocketQueueBox.socket,
        sessionId: session.sessionId,
        readOwnClientSnapshot: async (signal) =>
            (await readStateClientSnapshot(session.clientId, socketScope, { signal, authSession: session })).snapshot
    });
}

function initialiseBrowserHeartbeat(
    input: InitialiseBrowserTransportInput,
    ownWsConnectionGeneration: BrowserOwnWsConnectionGeneration
): ReturnType<typeof heartbeat.initHeartbeat> {
    return heartbeat.initHeartbeat(input.clientData, toBrowserHeartbeatOptions(input, ownWsConnectionGeneration));
}

/** The facade reads the one ledger the connect's carriers count against, never one of its own. */
export function toBrowserMiddleware(
    input: InitialiseBrowserTransportInput,
    carriers: Omit<
        RallarBrowserMiddleware,
        | 'volatileBudget'
        | 'orderingCounters'
        | 'publicationStageLimits'
        | 'outboundDiagnostics'
        | 'groupStateDiagnostics'
    >
): RallarBrowserMiddleware {
    return {
        ...carriers,
        volatileBudget: input.volatileBound.budget,
        orderingCounters: input.inboundOrderingCounters,
        publicationStageLimits: input.publicationStageLimits,
        outboundDiagnostics: input.options.diagnosticsPorts.outboundDiagnostics,
        groupStateDiagnostics: input.options.diagnosticsPorts.groupStateDiagnostics
    };
}

export function toBrowserWebSocketQueueBoxInput(
    input: InitialiseBrowserTransportInput,
    carrier: BrowserWebSocketCarrier
): CreateBrowserWebSocketQueueBox.Input {
    return {
        ...carrier,
        qosProvider: input.volatileBound.qosProvider,
        volatileBudget: input.volatileBound.budget,
        checkpointStores: input.checkpointStores.wsClient,
        submissionReadinessFaultPort: input.options.diagnosticsPorts.submissionReadinessFaultPort,
        clientData: input.clientData,
        inboundStores: input.inboundStores,
        inboundVolatileStores: input.inboundVolatileStores,
        durableWorkOwnership: input.options.durableWorkOwnership,
        signal: input.options.signal,
        connectTimeoutMs: input.options.timeoutMs ??
            DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS.connectTimeoutMsecs,
        newConnectionRequestId: input.creation.newConnectionRequestId,
        outboundDiagnostics: input.options.diagnosticsPorts.outboundDiagnostics,
        outboundSettlements: input.options.deliverySettlements.ws,
        inboundDiagnostics: input.inboundOrderingCounters.sink,
        onResyncRequired: input.options.onResyncRequired
    };
}

export function toRtcOverlayMulticastManagerInput(
    input: InitialiseBrowserTransportInput,
    carrier: BrowserRtcOverlayCarrier
): rtcEngine.InitialiseRtcOverlayMulticastManagerInput {
    return {
        ...carrier,
        qosProvider: input.volatileBound.qosProvider,
        volatileBudget: input.volatileBound.budget,
        checkpointStores: input.checkpointStores.rtcOverlay,
        durableWorkOwnership: input.options.durableWorkOwnership,
        outboundDiagnostics: input.options.diagnosticsPorts.outboundDiagnostics,
        outboundSettlements: input.options.deliverySettlements.rtc,
        faultPort: input.options.diagnosticsPorts.transportFaultPort,
        grantedTopics: input.options.grantedTopics,
        publicationCrypto: input.publicationCrypto,
        publicationVerifier: input.publicationVerifier,
        topicSubscriptions: input.options.topicSubscriptions,
        selfPrincipalId: input.clientData.clientId
    };
}

function assertRtcGroupSnapshotRefreshIsCurrent(
    input: InitialiseBrowserRtcTransportInput,
    signal: AbortSignal
): void {
    signal.throwIfAborted();
    if (readSession()?.sessionId !== input.clientData.sessionId) {
        throw new Error('RTC group-snapshot refresh belongs to an inactive browser session.');
    }
}

function toCommandOptions<T>(
    options: MiddlewareInitOptions
): CommandOptions<T> {
    return {
        signal: options.signal,
        timeoutMs: options.timeoutMs
    };
}

interface BrowserRuntimeStorageInput {
    readonly diagnosticsPorts: RallarDiagnosticsPorts;
    readonly runtimeStorage: ALRuntimeStorage;
}

function initialiseBrowserRuntimeStores(
    sessionId: string,
    scope: StateScope,
    storage: BrowserRuntimeStorageInput
): BrowserALStorageAvailability {
    const { diagnosticsPorts, runtimeStorage } = storage;
    initialiseBrowserCacheRepositories();
    const storageAvailability = configureBrowserALRuntimeStores(sessionId, { scope, diagnosticsPorts, runtimeStorage });
    initBrowserALRuntimeExpiryEviction({ currentScope: scope, storage: diagnosticsPorts.storage }).catch((error) =>
        console.error('Failed to initialise browser AL runtime expiry eviction:', toError(error))
    );
    return storageAvailability;
}

async function initialiseBrowserWebSocketTransport(
    input: InitialiseBrowserTransportInput,
    apiConfig: ApiConfigResponse
): Promise<BrowserWebSocketTransport> {
    const socket = createBrowserWebSocketClient(input, apiConfig);
    const qboxEngine = createBrowserQueueBoxEngine();
    let webSocketQueueBox: WsQueueBoxClientService;
    try {
        webSocketQueueBox = await createBrowserWebSocketQueueBox(
            toBrowserWebSocketQueueBoxInput(input, { qboxEngine, socket, serverPeerId: apiConfig.serverPeerId })
        ).catch((caught) => {
            const error = toError(caught);
            try {
                console.error('Failed to connect WebSocket client:', error);
            }
            catch { /* Preserve the actual connection failure if its reporting sink fails. */ }
            throw error;
        });
    }
    catch (caught) {
        await qboxEngine.stop().catch((failure) => reportBrowserStartupCleanupFailure(toError(failure)));
        throw caught;
    }
    return { qboxEngine, webSocketQueueBox };
}

function createBrowserWebSocketClient(
    input: InitialiseBrowserTransportInput,
    apiConfig: ApiConfig
): JsonWebSocketClient {
    return new JsonWebSocketClient(
        async (options) => await createBrowserWebSocketUrl(input, apiConfig, options),
        input.options.diagnosticsPorts.transportFaultPort
    );
}

async function createBrowserWebSocketUrl(
    input: InitialiseBrowserTransportInput,
    apiConfig: ApiConfig,
    connectOptions: WebSocketConnectOptions
): Promise<string> {
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
    return toApiWsUrl({
        wsBaseUrl: apiConfig.wsBaseUrl,
        createWsPath: apiConfig.endpoints.createWs,
        sessionId: input.session.sessionId,
        ticket: wsTicket.ticket,
        scope: input.options.scope
    });
}

async function initialiseBrowserRtcTransport(
    input: InitialiseBrowserRtcTransportInput
): Promise<BrowserRtcTransport> {
    const iceCandidates: IceConfig = await runMiddlewareCommand(
        (signal) => input.options.readIceCandidates(signal),
        input.options
    );
    const { webRtcConnectionService, rtcCaptureReceipt } = await initialiseBrowserRtcConnection(
        input,
        iceCandidates
    );
    const acquired: BrowserRtcAcquisitions = { webRtcConnectionService };
    try {
        const webRtcOverlayMulticastManager = rtcEngine.initialiseRtcOverlayMulticastManager(
            toRtcOverlayMulticastManagerInput(input, {
                webRtcConnectionService,
                qboxEngine: input.webSocketTransport.qboxEngine,
                replacedLayoutOverlapMs: input.replacedLayoutOverlapMs
            })
        );
        acquired.webRtcOverlayMulticastManager = webRtcOverlayMulticastManager;
        const rtcRxStreamer = rtcEngine.initialiseRtcRxStreamer(
            {
                webRtcOverlayMulticastManager,
                publicationCrypto: input.publicationCrypto,
                qboxEngine: input.webSocketTransport.qboxEngine,
                clientData: input.clientData,
                inboundStores: input.inboundStores,
                inboundVolatileStores: input.inboundVolatileStores,
                durableWorkOwnership: input.options.durableWorkOwnership,
                roomAuthorityRefresh: createBrowserRtcGroupSnapshotRefresh(input),
                inboundDiagnostics: input.inboundOrderingCounters.sink,
                onResyncRequired: input.options.onResyncRequired
            }
        );
        acquired.rtcRxStreamer = rtcRxStreamer;
        registerBrowserRttEgress(input, rtcRxStreamer);
        registerBrowserRtcPeerStreaming(webRtcConnectionService, rtcRxStreamer);
        const webRtcGroupManager = createBrowserRtcGroupManager(
            input,
            webRtcConnectionService,
            rtcRxStreamer
        );
        acquired.webRtcGroupManager = webRtcGroupManager;
        return {
            rtcCaptureReceipt,
            webRtcConnectionService,
            rtcRxStreamer,
            webRtcGroupManager,
            webRtcOverlayMulticastManager
        };
    }
    catch (caught) {
        await closeBrowserTransportResources(acquired)
            .catch((failure) => reportBrowserStartupCleanupFailure(toError(failure)));
        throw caught;
    }
}

function createBrowserRtcGroupSnapshotRefresh(
    input: InitialiseBrowserRtcTransportInput
): RtcGroupSnapshotRefresh {
    return new RtcGroupSnapshotRefresh({
        refreshGroupSnapshot: async (roomRef, minSnapshotVersion, signal) =>
            await refreshBrowserRtcGroupSnapshot(input, { roomRef, minSnapshotVersion, signal })
    });
}

async function refreshBrowserRtcGroupSnapshot(
    input: InitialiseBrowserRtcTransportInput,
    request: BrowserRtcGroupSnapshotRequest
): Promise<void> {
    const { roomRef, minSnapshotVersion, signal } = request;
    assertRtcGroupSnapshotRefreshIsCurrent(input, signal);
    const scope = toStateScope(roomRef);
    const observed = groupStateSnapshotsRepository.findGroupStateSnapshotByRef(roomRef);
    const { snapshot } = await new Command(
        async (commandSignal) =>
            await readStateGroupSnapshot(
                roomRef.groupId,
                scope,
                {
                    authSession: input.session,
                    signal: commandSignal,
                    minCausalRevision: {
                        groupRevision: minSnapshotVersion,
                        presenceRevision: 0
                    }
                }
            ),
        { signal, timeoutMs: input.options.timeoutMs }
    ).run();
    assertRtcGroupSnapshotRefreshIsCurrent(input, signal);
    await acceptAuthoritativeGroupStateSnapshot(
        snapshot,
        scope,
        {
            assertCanMutate: () => assertRtcGroupSnapshotRefreshIsCurrent(input, signal),
            rereadGroupSnapshots: async (refreshScope) => await rereadBrowserRtcGroups(input, refreshScope, signal)
        }
    );
    assertRtcGroupSnapshotRefreshIsCurrent(input, signal);
    if (observed) {
        acceptAuthoritativeGroupSessionLeaseAdvance({
            expected: observed,
            acquired: snapshot,
            scope,
            assertCanMutate: () => assertRtcGroupSnapshotRefreshIsCurrent(input, signal)
        });
    }
    await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();
    assertRtcGroupSnapshotRefreshIsCurrent(input, signal);
    input.webSocketTransport.qboxEngine.wake();
}

async function rereadBrowserRtcGroups(
    input: InitialiseBrowserRtcTransportInput,
    refreshScope: StateScope,
    signal: AbortSignal
): Promise<readonly GroupSnapshot[]> {
    const groups = await new Command(
        async (commandSignal) =>
            await listStateGroups(
                refreshScope,
                {
                    authSession: input.session,
                    signal: commandSignal
                }
            ),
        { signal, timeoutMs: input.options.timeoutMs }
    ).run();
    assertRtcGroupSnapshotRefreshIsCurrent(input, signal);
    validateAuthoritativeGroupSnapshotList(groups, refreshScope);
    return groups;
}

function initialiseBrowserRtcConnection(
    input: InitialiseBrowserRtcTransportInput,
    iceCandidates: IceConfig
): Promise<rtcEngine.BrowserRtcConnectionInitialization> {
    return rtcEngine.initialiseRtcConnectionService({
        rtcCaptureConfiguration: input.options.rtcCaptureConfiguration,
        connectionId: input.connectionId,
        webSocketQueueBox: input.webSocketTransport.webSocketQueueBox,
        qboxEngine: input.webSocketTransport.qboxEngine,
        clientData: input.clientData,
        iceCandidates,
        dataChannelName: 'rtc-data-channel',
        rtcSignalingTopicId: input.rtcSignalingTopicId,
        dataChannelLanes: input.options.dataChannelLanes ??
            [DEFAULT_REALTIME_DATA_CHANNEL_LANE],
        maxPeerConnections: input.options.maxPeerConnections,
        faultPort: input.options.diagnosticsPorts.transportFaultPort,
        signalingDiagnostics: input.options.diagnosticsPorts.signalingDiagnostics
    });
}

function registerBrowserRtcPeerStreaming(
    webRtcConnectionService: WebRtcConnectionService,
    rtcRxStreamer: WebRtcRxStreamerService
): void {
    webRtcConnectionService.onRtcPeerLifecycleDo('rtc-rx-streamer', {
        onCreated(peer: WebRtcConnectionService.Peer) {
            rtcRxStreamer.addPeer(peer);
        },
        onDeleted(peer: WebRtcConnectionService.Peer) {
            rtcRxStreamer.removePeer(peer);
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
            rttReportingDegreeLimit: input.options.rttReportingDegreeLimit,
            onDesiredPeerIdsChanged: ({ rttReportingPeerIds }) =>
                rtcRxStreamer.setRttReportingPeerIds(rttReportingPeerIds),
            ...createBrowserRtcHeldOfferReleases(webRtcConnectionService)
        }
    );
    webRtcGroupManager.startReconcileWakes();
    rtcRxStreamer.setRttReportingPeerIds(
        webRtcGroupManager.rttReportingPeerIds({ degreeLimit: input.options.rttReportingDegreeLimit })
    );
    configureBrowserRtcPeerCreationPolicies(
        webRtcConnectionService,
        webRtcGroupManager
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
        options: stateCacheOptions,
        groupStateDiagnostics: input.options.diagnosticsPorts.groupStateDiagnostics
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
    snapshots: StateSnapshots
): Promise<void> {
    await browserStateCacheLifecycle.hydrate({
        webRtcGroupManager: input.webRtcGroupManager,
        clientData: input.clientData,
        clientSnapshots: snapshots.clients,
        groupSnapshots: snapshots.groups,
        options: stateCacheOptions,
        groupStateDiagnostics: input.options.diagnosticsPorts.groupStateDiagnostics
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
        cancelSnapshotAssemblies: () => browserStateCacheLifecycle.cancelSnapshotAssemblies(),
        socket: input.webSocketQueueBox.socket,
        resyncStateSnapshots: async () => await resyncBrowserStateSnapshots(input, stateCacheOptions),
        resyncGroupTopologies: async (refreshedGroups) => {
            await hydrateBrowserGroupTopologies(input, refreshedGroups);
        },
        isCurrentGeneration: () => readSession()?.sessionId === input.clientData.sessionId
    });
}

async function resyncBrowserStateSnapshots(
    input: InitialiseBrowserStateTransportInput,
    stateCacheOptions: StateCacheScopeOptions
): Promise<readonly GroupSnapshot[]> {
    const refreshed = await refreshStateSnapshots(input.options.scope, {
        command: toCommandOptions(input.options)
    });
    await hydrateBrowserStateCaches(input, stateCacheOptions, refreshed);
    return refreshed.groups;
}

function runMiddlewareCommand<T>(
    supplier: (signal?: AbortSignal) => T | Promise<T>,
    options: MiddlewareInitOptions
): Promise<T> {
    return new Command<T>(supplier, toCommandOptions(options)).run();
}

function readBrowserConnectionIdentity(): RtcSignalingDiagnostics.Readout<string> {
    try {
        const identity = crypto.randomUUID();
        return Object.freeze(
            identity.length > 0
                ? { status: 'observed', value: identity }
                : { status: 'unavailable', reason: 'identity-invalid' }
        );
    }
    catch {
        return Object.freeze({ status: 'unavailable', reason: 'identity-source-failed' });
    }
}
