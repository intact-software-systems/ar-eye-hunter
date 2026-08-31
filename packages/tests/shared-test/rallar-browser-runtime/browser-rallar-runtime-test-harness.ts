import type { BlackBoxRallarEvent } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import {
    createBlackBoxRallarRuntime,
    type BlackBoxRallarRuntimeInstallationTarget
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import {
    facadeBehavior,
    facadeRecords,
    facadeSession,
    rallarFacadeTestDouble,
    resetBrowserRuntimeFacadeTestDouble
} from './browser-runtime-facade-test-double.ts';

export const facade = {
    behavior: facadeBehavior,
    records: facadeRecords,
    session: facadeSession,
    rallar: rallarFacadeTestDouble
};

export const events: BlackBoxRallarEvent[] = [];

const defaultRtcStatus = {
    sessionId: 'session-1',
    laneId: 'realtime',
    knownPeerIds: [],
    activePeerIds: [],
    peerIdsWithNoReconnectableLanes: [],
    readyPeerIds: [],
    peers: []
};

const defaultRtcDiagnostics = {
    sessionId: 'session-1',
    generatedAtEpochMs: 123,
    peerCount: 1,
    connectedPeerCount: 1,
    relayPeerCount: 0,
    peers: [{
        peerId: 'peer-1',
        connection: {
            hasLocalDescription: true,
            hasRemoteDescription: true,
            reconnectAttempts: 0,
            reconnecting: false,
            disconnectPending: false,
            makingOffer: false,
            ignoreOffer: false,
            iceCandidateQueueSize: 0,
            remoteStreamIds: []
        },
        connectionDiagnostics: {
            connectCallCount: 1,
            connectIgnoredCount: 0,
            resetCount: 0,
            closedPeerConnectionCount: 0,
            negotiationNeededCount: 0,
            negotiationSkippedCount: 0,
            offerCreatedCount: 1,
            inboundOfferCount: 0,
            inboundAnswerCount: 1,
            inboundIceCandidateCount: 0,
            staleAnswerIgnoredCount: 0,
            offerCollisionCount: 0,
            ignoredOfferCollisionCount: 0,
            politeOfferRollbackCount: 0,
            outboundOfferCount: 1,
            outboundAnswerCount: 0,
            outboundIceCandidateCount: 0,
            queuedIceCandidateCount: 0,
            addedIceCandidateCount: 0,
            flushedIceCandidateCount: 0,
            ignoredIceCandidateForIgnoredOfferCount: 0,
            reconnectAttemptCount: 0,
            reconnectTimerAlreadyActiveCount: 0,
            reconnectExhaustedCount: 0,
            iceRestartCount: 0,
            iceRestartSkippedConnectedCount: 0,
            disconnectTimerScheduledCount: 0,
            disconnectTimerAlreadyActiveCount: 0,
            disconnectTimerClearedCount: 0,
            disconnectTimerFiredCount: 0,
            outboundSignalingErrorCount: 0,
            inboundSignalingErrorCount: 0,
            pendingIceCandidateQueueLength: 0,
            reconnectAttemptsInFlight: 0,
            hasReconnectTimer: false
        },
        lanes: [],
        usesRelay: false,
        statsAvailable: false
    }]
};

export function resetFacade(): void {
    resetBrowserRuntimeFacadeTestDouble();
    events.length = 0;
    facade.behavior.rtcStatus.mockReturnValue(defaultRtcStatus);
    facade.behavior.rtcDiagnostics.mockResolvedValue(defaultRtcDiagnostics);
}

export async function loadRuntime(): Promise<BlackBoxRallarRuntime> {
    const target: BlackBoxRallarRuntimeInstallationTarget = {
        __blackBoxRallarEmit: (event) => {
            events.push(event);
        }
    };
    return createBlackBoxRallarRuntime({
        facade: facade.rallar,
        targetWindow: target,
        clock: { now: Date.now },
        delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    });
}

export function topics(): readonly string[] {
    return events.map((event) => event.topic ?? '');
}
