import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';
import { QRtcSignalingType } from '@shared/webrtc/QRtcSignalingContracts.ts';

import { installRtcBenchmarkNativeRuntime, RtcBenchmarkNativePeer } from '../native-rtc/rtc-benchmark-native-peer.ts';

export interface RtcPeerConnectionDiagnosticsInputDto {
    readonly peers: number;
    readonly iceCandidatesPerPeer: number;
    readonly offerCollisionsPerPeer: number;
}

export interface RtcPeerConnectionDiagnosticsPeerInput {
    readonly id: string;
    readonly isPolite: boolean;
    readonly onSend: () => void;
}

export interface RtcPeerConnectionDiagnosticsPeer {
    connect(): void;
    receiveIceCandidate(candidateIndex: number): Promise<void>;
    receiveOffer(): Promise<void>;
    beginOfferCollision(): void;
    receiveCollidingOffer(collisionIndex: number): Promise<void>;
    failConnection(): void;
    reconnect(): Promise<void>;
    drainSignaling(): Promise<void>;
    exhaustReconnects(): Promise<void>;
    readDiagnostics(): QRtcPeerConnection.Diagnostics;
}

export interface RtcPeerConnectionDiagnosticsDependencies {
    createPeer(input: RtcPeerConnectionDiagnosticsPeerInput): RtcPeerConnectionDiagnosticsPeer;
    reset(): void;
    drainTimers(): Promise<void>;
    getPendingTimerCount(): number;
    monotonicNowMs(): number;
}

export interface RtcPeerConnectionDiagnosticsCleanupState {
    readonly pendingIceCandidateQueueLength: number;
    readonly reconnectAttemptsInFlight: number;
    readonly activeReconnectTimerCount: number;
    readonly pendingTimerCount: number;
}

export interface RtcPeerConnectionDiagnosticsResult {
    readonly durationMs: number;
    readonly peerCount: number;
    readonly signalingMessagesSent: number;
    readonly diagnostics: Readonly<Record<string, number>>;
    readonly cleanup: RtcPeerConnectionDiagnosticsCleanupState;
}

interface RunRtcPeerConnectionDiagnosticsPeerInput {
    readonly diagnosticsInput: RtcPeerConnectionDiagnosticsInputDto;
    readonly index: number;
    readonly onSend: () => void;
}

interface QueuedTimer {
    readonly id: ReturnType<typeof setTimeout>;
    readonly callback: () => void | Promise<void>;
}

export async function runRtcPeerConnectionDiagnostics(
    input: RtcPeerConnectionDiagnosticsInputDto,
    dependencies: RtcPeerConnectionDiagnosticsDependencies
): Promise<RtcPeerConnectionDiagnosticsResult> {
    dependencies.reset();
    const startedAt = dependencies.monotonicNowMs();
    const diagnostics: Record<string, number> = {};
    let signalingMessagesSent = 0;
    let activeReconnectTimerCount = 0;

    for (let index = 0; index < input.peers; index += 1) {
        const onSend = () => {
            signalingMessagesSent += 1;
        };
        const peerInput = { diagnosticsInput: input, index, onSend };
        const politeDiagnostics = await runPolitePeer(peerInput, dependencies);
        const impoliteDiagnostics = await runImpolitePeer(peerInput, dependencies);
        addNumericDiagnostics(diagnostics, politeDiagnostics);
        addNumericDiagnostics(diagnostics, impoliteDiagnostics);
        activeReconnectTimerCount += Number(politeDiagnostics.hasReconnectTimer);
        activeReconnectTimerCount += Number(impoliteDiagnostics.hasReconnectTimer);
    }

    return {
        durationMs: dependencies.monotonicNowMs() - startedAt,
        peerCount: input.peers * 2,
        signalingMessagesSent,
        diagnostics,
        cleanup: {
            pendingIceCandidateQueueLength: diagnostics.pendingIceCandidateQueueLength ?? 0,
            reconnectAttemptsInFlight: diagnostics.reconnectAttemptsInFlight ?? 0,
            activeReconnectTimerCount,
            pendingTimerCount: dependencies.getPendingTimerCount()
        }
    };
}

async function runPolitePeer(
    input: RunRtcPeerConnectionDiagnosticsPeerInput,
    dependencies: RtcPeerConnectionDiagnosticsDependencies
): Promise<QRtcPeerConnection.Diagnostics> {
    const peer = dependencies.createPeer({
        id: `polite-${input.index}`,
        isPolite: true,
        onSend: input.onSend
    });
    peer.connect();
    for (
        let candidateIndex = 0;
        candidateIndex < input.diagnosticsInput.iceCandidatesPerPeer;
        candidateIndex += 1
    ) {
        await peer.receiveIceCandidate(candidateIndex);
    }
    await peer.receiveOffer();
    return peer.readDiagnostics();
}

async function runImpolitePeer(
    input: RunRtcPeerConnectionDiagnosticsPeerInput,
    dependencies: RtcPeerConnectionDiagnosticsDependencies
): Promise<QRtcPeerConnection.Diagnostics> {
    const peer = dependencies.createPeer({
        id: `impolite-${input.index}`,
        isPolite: false,
        onSend: input.onSend
    });
    peer.connect();
    peer.beginOfferCollision();
    for (
        let collisionIndex = 0;
        collisionIndex < input.diagnosticsInput.offerCollisionsPerPeer;
        collisionIndex += 1
    ) {
        await peer.receiveCollidingOffer(collisionIndex);
    }
    peer.failConnection();
    await peer.reconnect();
    await peer.reconnect();
    await dependencies.drainTimers();
    await peer.drainSignaling();
    await peer.exhaustReconnects();
    return peer.readDiagnostics();
}

function addNumericDiagnostics(
    aggregate: Record<string, number>,
    diagnostics: QRtcPeerConnection.Diagnostics
): void {
    for (const [key, value] of Object.entries(diagnostics)) {
        if (typeof value === 'number') {
            aggregate[key] = (aggregate[key] ?? 0) + value;
        }
    }
}

export interface RtcPeerConnectionDiagnosticsRuntime {
    readonly dependencies: RtcPeerConnectionDiagnosticsDependencies;
    restore(): void;
}

export function createRtcPeerConnectionDiagnosticsDependencies(): RtcPeerConnectionDiagnosticsRuntime {
    const nativeRuntime = installRtcBenchmarkNativeRuntime();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let timers: QueuedTimer[] = [];
    const scheduleTimer = (...arguments_: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> => {
        const [callback, _delayMs, ...callbackArguments] = arguments_;
        if (typeof callback !== 'function') {
            throw new Error('The RTC benchmark requires callable timer callbacks');
        }
        // Keep the platform's complete handle shape while the benchmark owns
        // deterministic dispatch. No native timer remains scheduled.
        const id = originalSetTimeout(() => {}, 2_147_483_647);
        originalClearTimeout(id);
        timers.push({ id, callback: () => callback(...callbackArguments) });
        return id;
    };
    const cancelTimer = (...arguments_: Parameters<typeof clearTimeout>): void => {
        const [id] = arguments_;
        timers = timers.filter((timer) => timer.id !== id);
    };
    Object.defineProperty(globalThis, 'setTimeout', { configurable: true, writable: true, value: scheduleTimer });
    Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, writable: true, value: cancelTimer });
    return {
        dependencies: {
            createPeer: createPeerAdapter,
            reset() {
                nativeRuntime.peers.length = 0;
                timers = [];
            },
            async drainTimers() {
                while (timers.length > 0) {
                    const pending = timers;
                    timers = [];
                    for (const timer of pending) {
                        await timer.callback();
                    }
                }
            },
            getPendingTimerCount: () => timers.length,
            monotonicNowMs: () => performance.now()
        },
        restore() {
            nativeRuntime.restore();
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
        }
    };
}

function createPeerAdapter(
    input: RtcPeerConnectionDiagnosticsPeerInput
): RtcPeerConnectionDiagnosticsPeer {
    const peer = createDiagnosticsPeerConnection(input);
    let nativePeer: RtcBenchmarkNativePeer | undefined;
    const requireNativePeer = (): RtcBenchmarkNativePeer => {
        if (!nativePeer) {
            throw new Error('Expected fake RTCPeerConnection instance.');
        }
        return nativePeer;
    };
    return {
        connect() {
            peer.connect();
            if (!(peer.status.pc instanceof RtcBenchmarkNativePeer)) {
                throw new Error('Expected the installed native RTC peer');
            }
            nativePeer = peer.status.pc;
        },
        receiveIceCandidate: (index) =>
            peer.handleSignal(QRtcSignalingType.IceCandidate, {
                description: null,
                candidate: { candidate: `candidate-${input.id}-${index}`, sdpMid: '0', sdpMLineIndex: 0 }
            }),
        receiveOffer: () =>
            peer.handleSignal(QRtcSignalingType.Offer, {
                description: { type: 'offer', sdp: `remote-offer-${input.id}` },
                candidate: null
            }),
        beginOfferCollision() {
            requireNativePeer().signalingState = 'have-local-offer';
        },
        receiveCollidingOffer: (index) =>
            peer.handleSignal(QRtcSignalingType.Offer, {
                description: {
                    type: 'offer',
                    sdp: `colliding-offer-${input.id}-${index}`
                },
                candidate: null
            }),
        failConnection: () => {
            requireNativePeer().connectionState = 'failed';
        },
        reconnect: () => peer.handleReconnect(),
        drainSignaling: () => requireNativePeer().whenIceRestarted(),
        exhaustReconnects: async () => {
            // Accepted B01 input: one retry followed by the exhausted starting state.
            peer.status.reconnectAttempts = 5;
            await peer.handleReconnect();
        },
        readDiagnostics: () => peer.readDiagnostics()
    };
}

function createDiagnosticsPeerConnection(input: RtcPeerConnectionDiagnosticsPeerInput): QRtcPeerConnection {
    return new QRtcPeerConnection(
        { send: async () => input.onSend() },
        {
            sessionId: `self-${input.id}`,
            token: 'token',
            peerSessionId: `peer-${input.id}`,
            iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
            isPolite: input.isPolite
        }
    );
}
