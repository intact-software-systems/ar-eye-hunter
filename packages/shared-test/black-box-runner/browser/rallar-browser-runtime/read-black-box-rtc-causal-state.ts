import type { AuthSession } from '@shared/api/api-config.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import type { WebRtcGroupManager, WebRtcGroupManagerDiagnostics } from '@shared/services/web-rtc-group-manager.ts';

export interface BlackBoxRtcCausalState {
    readonly localSessionId: string;
    readonly desiredPeerIds: readonly string[];
    readonly onlinePeerIds: readonly string[];
    readonly connectablePeerIds: readonly string[];
    readonly knownPeerIds: readonly string[];
    readonly managerDiagnostics: WebRtcGroupManagerDiagnostics;
    readonly attempts: readonly BlackBoxRtcPeerAttempt[];
}

export interface BlackBoxRtcPeerAttempt {
    readonly peerId: string;
    readonly diagnostics: WebRtcConnectionService.PeerConnectionAttemptDiagnostics | null;
}

export interface BlackBoxRtcCausalReadPort {
    readMiddleware(): {
        readonly session: Pick<AuthSession, 'sessionId'>;
        readonly middleware: {
            readonly webRtcGroupManager: Pick<WebRtcGroupManager, 'state' | 'readDiagnostics'>;
            readonly webRtcConnectionService: Pick<
                WebRtcConnectionService,
                'knownPeerIds' | 'peerConnectionAttemptDiagnostics'
            >;
        };
    } | undefined;
}

export function readBlackBoxRtcCausalState(runtime: BlackBoxRtcCausalReadPort): BlackBoxRtcCausalState | undefined {
    const context = runtime.readMiddleware();
    if (!context) {
        return undefined;
    }
    const { webRtcGroupManager, webRtcConnectionService } = context.middleware;
    const state = webRtcGroupManager.state();
    const desiredPeerIds = toSortedPeerIds(state.desiredPeerIds);
    const knownPeerIds = toSortedPeerIds(webRtcConnectionService.knownPeerIds());
    return {
        localSessionId: context.session.sessionId,
        desiredPeerIds,
        knownPeerIds,
        onlinePeerIds: toSortedPeerIds(state.onlinePeerIds),
        connectablePeerIds: toSortedPeerIds(state.connectablePeerIds),
        managerDiagnostics: webRtcGroupManager.readDiagnostics(),
        attempts: toSortedPeerIds([...desiredPeerIds, ...knownPeerIds]).map((peerId) => ({
            peerId,
            diagnostics: webRtcConnectionService.peerConnectionAttemptDiagnostics(peerId) ?? null
        }))
    };
}

function toSortedPeerIds(peerIds: readonly string[]): string[] {
    return [...new Set(peerIds)].sort();
}
