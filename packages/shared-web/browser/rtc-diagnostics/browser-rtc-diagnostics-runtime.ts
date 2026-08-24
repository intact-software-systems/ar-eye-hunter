import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type {
    RallarRtcDiagnostics,
    RallarRtcDiagnosticsOptions,
    RallarRtcPeerDiagnostics,
    RallarRtcPeerStatus,
    RallarRtcStatus,
    RallarRtcStatusOptions
} from '@shared-web/browser/rallar-rtc-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { readOverlayAdoptionDiagnostics } from '@shared/repository/overlays-repository.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID, type QRtcPeerDto } from '@shared/services/WebRtcConnectionService.ts';
import { readSelectedCandidatePairDiagnostics } from './read-selected-candidate-pair-diagnostics.ts';

export namespace BrowserRtcDiagnosticsRuntime {
    export interface Input {
        readMiddleware(): ApiMiddleware | undefined;
        readSession(): AuthSession | undefined;
        readStatus(options: RallarRtcStatusOptions): RallarRtcStatus;
    }

    export interface PeerInput {
        readonly status: RallarRtcPeerStatus;
        readonly peer: QRtcPeerDto | undefined;
        readonly options: RallarRtcDiagnosticsOptions;
    }
}

/** Owns browser RTC diagnostic collection and candidate-pair failure reporting. */
export class BrowserRtcDiagnosticsRuntime {
    private readonly input: BrowserRtcDiagnosticsRuntime.Input;

    constructor(input: BrowserRtcDiagnosticsRuntime.Input) {
        this.input = input;
    }

    async read(options: RallarRtcDiagnosticsOptions = {}): Promise<RallarRtcDiagnostics> {
        const ctx = this.input.readMiddleware();
        const sessionId = ctx?.session.sessionId ?? this.input.readSession()?.sessionId;
        if (!ctx) {
            return {
                sessionId,
                generatedAtEpochMs: Date.now(),
                peerCount: 0,
                connectedPeerCount: 0,
                relayPeerCount: 0,
                peers: []
            };
        }

        const service = ctx.middleware.webRtcConnectionService;
        const status = this.input.readStatus({
            ...options,
            laneId: options.laneIds?.[0] ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID
        });
        const peerIds = options.peerIds ?? status.knownPeerIds;
        const peers = await Promise.all(
            [...new Set(peerIds)].map(async (peerId) => {
                const peerStatus = status.peers.find((peer) => peer.peerId === peerId) ??
                    toMissingRtcPeerStatus(peerId);
                return await this.readPeer({
                    status: peerStatus,
                    peer: service.readPeer(peerId),
                    options
                });
            })
        );

        return {
            sessionId,
            generatedAtEpochMs: Date.now(),
            peerCount: peers.length,
            connectedPeerCount: peers.filter(
                (peer) => peer.connection.connectionState === 'connected'
            ).length,
            relayPeerCount: peers.filter((peer) => peer.usesRelay).length,
            peers,
            groupManager: ctx.middleware.webRtcGroupManager.readDiagnostics?.(),
            overlayAdoption: readOverlayAdoptionDiagnostics(),
            connectionAttemptBudget: service.readPeerConnectionAttemptBudgetDiagnostics?.()
        };
    }

    private async readPeer(input: BrowserRtcDiagnosticsRuntime.PeerInput): Promise<RallarRtcPeerDiagnostics> {
        const laneIds = input.options.laneIds ? new Set(input.options.laneIds) : undefined;
        const lanes = laneIds
            ? input.status.lanes.filter((lane) => laneIds.has(lane.laneId))
            : input.status.lanes;
        const connectionDiagnostics = input.peer?.connection.readDiagnostics?.();

        try {
            const selectedCandidatePair = await readSelectedCandidatePairDiagnostics(
                input.peer?.connection.status.pc
            );
            const diagnostics = {
                peerId: input.status.peerId,
                connection: input.status.connection,
                lanes,
                selectedCandidatePair,
                usesRelay: selectedCandidatePair?.usesRelay ?? false,
                statsAvailable: selectedCandidatePair !== undefined
            };
            return connectionDiagnostics === undefined
                ? diagnostics
                : { ...diagnostics, connectionDiagnostics };
        }
        catch (error) {
            const diagnostics = {
                peerId: input.status.peerId,
                connection: input.status.connection,
                lanes,
                usesRelay: false,
                statsAvailable: false,
                statsError: error instanceof Error ? error.message : String(error)
            };
            return connectionDiagnostics === undefined
                ? diagnostics
                : { ...diagnostics, connectionDiagnostics };
        }
    }
}

function toMissingRtcPeerStatus(peerId: string): RallarRtcPeerStatus {
    return {
        peerId,
        connection: {
            hasLocalDescription: false,
            hasRemoteDescription: false,
            reconnectAttempts: 0,
            reconnecting: false,
            disconnectPending: false,
            makingOffer: false,
            ignoreOffer: false,
            iceCandidateQueueSize: 0,
            remoteStreamIds: []
        },
        lanes: [],
        isActive: false,
        hasNoReconnectableLanes: false,
        isRoutable: false,
        readyLaneIds: []
    };
}
