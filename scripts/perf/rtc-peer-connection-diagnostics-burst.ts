import {
    QRtcPeerConnection,
    type QRtcPeerConnectionDiagnostics,
} from '@shared/webrtc/QRtcPeerConnection.ts';
import { QRtcSignalingType } from '@shared/webrtc/QRtcSignalingContracts.ts';

type Args = Readonly<{
    peers: number;
    iceCandidatesPerPeer: number;
    offerCollisionsPerPeer: number;
    runs: number;
    out: string;
}>;

type NumericDiagnostics = {
    [Key in keyof QRtcPeerConnectionDiagnostics as QRtcPeerConnectionDiagnostics[Key] extends number
        ? Key
        : never]: number;
};

type BenchResult = Readonly<{
    run: number;
    durationMs: number;
    peerCount: number;
    iceCandidatesPerPeer: number;
    offerCollisionsPerPeer: number;
    signalingMessagesSent: number;
    diagnostics: NumericDiagnostics;
}>;

type QueuedTimer = Readonly<{
    id: number;
    callback: () => void | Promise<void>;
}>;

let nextTimerId = 1;
let timers: QueuedTimer[] = [];

async function main(): Promise<void> {
    const args = parseArgs();
    const writeLine = console.log.bind(console);
    console.log = () => {
    };
    console.warn = () => {
    };

    installFakePeerConnection();

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;

    (globalThis as unknown as {
        setTimeout: typeof setTimeout;
        clearTimeout: typeof clearTimeout;
    }).setTimeout = ((callback: () => void | Promise<void>) => {
        const id = nextTimerId++;
        timers.push({ id, callback });
        return id;
    }) as typeof setTimeout;
    (globalThis as unknown as {
        clearTimeout: typeof clearTimeout;
    }).clearTimeout = ((id: number) => {
        timers = timers.filter((timer) => timer.id !== id);
    }) as typeof clearTimeout;

    try {
        const results: BenchResult[] = [];

        for (let run = 1; run <= args.runs; run++) {
            FakeRTCPeerConnection.instances = [];
            timers = [];
            const start = performance.now();
            const diagnostics = createZeroDiagnostics();
            let signalingMessagesSent = 0;

            for (let index = 0; index < args.peers; index++) {
                const politePeer = createPeer(`polite-${index}`, true, () => {
                    signalingMessagesSent++;
                });
                politePeer.connect();

                for (let candidateIndex = 0; candidateIndex < args.iceCandidatesPerPeer; candidateIndex++) {
                    await politePeer.handleSignal(QRtcSignalingType.IceCandidate, {
                        description: null,
                        candidate: {
                            candidate: `candidate-${index}-${candidateIndex}`,
                            sdpMid: '0',
                            sdpMLineIndex: 0,
                        },
                    });
                }

                await politePeer.handleSignal(QRtcSignalingType.Offer, {
                    description: {
                        type: 'offer',
                        sdp: `remote-offer-${index}`,
                    } as RTCSessionDescription,
                    candidate: null,
                });

                addDiagnostics(diagnostics, politePeer.readDiagnostics());

                const impolitePeer = createPeer(`impolite-${index}`, false, () => {
                    signalingMessagesSent++;
                });
                impolitePeer.connect();
                const pc = FakeRTCPeerConnection.instances.at(-1);
                if (!pc) {
                    throw new Error('Expected fake RTCPeerConnection instance');
                }
                impolitePeer.status.makingOffer = true;
                pc.signalingState = 'have-local-offer';

                for (let collisionIndex = 0; collisionIndex < args.offerCollisionsPerPeer; collisionIndex++) {
                    await impolitePeer.handleSignal(QRtcSignalingType.Offer, {
                        description: {
                            type: 'offer',
                            sdp: `colliding-offer-${index}-${collisionIndex}`,
                        } as RTCSessionDescription,
                        candidate: null,
                    });
                }

                pc.connectionState = 'failed';
                await impolitePeer.handleReconnect();
                await impolitePeer.handleReconnect();
                await drainTimers();
                await (impolitePeer as unknown as { signalingChain: Promise<void> }).signalingChain;
                impolitePeer.status.reconnectAttempts = 5;
                await impolitePeer.handleReconnect();

                addDiagnostics(diagnostics, impolitePeer.readDiagnostics());
            }

            results.push({
                run,
                durationMs: performance.now() - start,
                peerCount: args.peers * 2,
                iceCandidatesPerPeer: args.iceCandidatesPerPeer,
                offerCollisionsPerPeer: args.offerCollisionsPerPeer,
                signalingMessagesSent,
                diagnostics,
            });
        }

        await Deno.writeTextFile(
            args.out,
            JSON.stringify({
                createdAt: new Date().toISOString(),
                input: args,
                results,
            }, null, 2),
        );

        writeLine(`Wrote ${args.out}`);
    } finally {
        (globalThis as unknown as {
            setTimeout: typeof setTimeout;
            clearTimeout: typeof clearTimeout;
        }).setTimeout = originalSetTimeout;
        (globalThis as unknown as {
            clearTimeout: typeof clearTimeout;
        }).clearTimeout = originalClearTimeout;
    }
}

function parseArgs(): Args {
    return {
        peers: Number(readArg('--peers') ?? '500'),
        iceCandidatesPerPeer: Number(readArg('--ice-candidates') ?? '5'),
        offerCollisionsPerPeer: Number(readArg('--offer-collisions') ?? '3'),
        runs: Number(readArg('--runs') ?? '3'),
        out: readArg('--out') ??
            'tmp/perf/results/rtc-peer-connection-diagnostics-burst.json',
    };
}

function readArg(name: string): string | undefined {
    return Deno.args.find((arg) => arg.startsWith(`${name}=`))
        ?.slice(name.length + 1);
}

function createPeer(
    id: string,
    isPolite: boolean,
    onSend: () => void,
): QRtcPeerConnection {
    return new QRtcPeerConnection(
        {
            send: async () => {
                onSend();
            },
        },
        {
            sessionId: `self-${id}`,
            token: 'token',
            peerSessionId: `peer-${id}`,
            iceCandidates: {
                iceServers: [],
                expiresAtEpochMs: Date.now() + 60_000,
            },
            isPolite,
        },
    );
}

async function drainTimers(): Promise<void> {
    while (timers.length > 0) {
        const pending = timers;
        timers = [];

        for (const timer of pending) {
            await timer.callback();
        }
    }
}

function createZeroDiagnostics(): NumericDiagnostics {
    return {
        connectCallCount: 0,
        connectIgnoredCount: 0,
        resetCount: 0,
        closedPeerConnectionCount: 0,
        negotiationNeededCount: 0,
        negotiationSkippedCount: 0,
        offerCreatedCount: 0,
        inboundOfferCount: 0,
        inboundAnswerCount: 0,
        inboundIceCandidateCount: 0,
        staleAnswerIgnoredCount: 0,
        offerCollisionCount: 0,
        ignoredOfferCollisionCount: 0,
        politeOfferRollbackCount: 0,
        outboundOfferCount: 0,
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
        outboundSignalingErrorCount: 0,
        inboundSignalingErrorCount: 0,
        pendingIceCandidateQueueLength: 0,
        reconnectAttemptsInFlight: 0,
    };
}

function addDiagnostics(
    aggregate: NumericDiagnostics,
    diagnostics: QRtcPeerConnectionDiagnostics,
): void {
    for (const [key, value] of Object.entries(diagnostics)) {
        if (typeof value === 'number') {
            aggregate[key as keyof NumericDiagnostics] += value;
        }
    }
}

function installFakePeerConnection(): void {
    (globalThis as unknown as { RTCPeerConnection: typeof FakeRTCPeerConnection })
        .RTCPeerConnection = FakeRTCPeerConnection;
}

class FakeRTCPeerConnection {
    static instances: FakeRTCPeerConnection[] = [];

    connectionState: RTCPeerConnectionState = 'new';
    signalingState: RTCSignalingState = 'stable';
    iceConnectionState: RTCIceConnectionState = 'new';
    iceGatheringState: RTCIceGatheringState = 'new';
    localDescription: RTCSessionDescription | null = null;
    remoteDescription: RTCSessionDescription | null = null;

    onnegotiationneeded: (() => Promise<void>) | null = null;
    onicecandidate:
        | ((event: { candidate: RTCIceCandidateInit | null }) => Promise<void>)
        | null = null;
    ondatachannel: ((event: RTCDataChannelEvent) => Promise<void>) | null = null;
    ontrack: ((event: RTCTrackEvent) => Promise<void>) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    onsignalingstatechange: (() => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;

    constructor(_configuration: RTCConfiguration) {
        FakeRTCPeerConnection.instances.push(this);
    }

    addEventListener(_type: string, _listener: (event?: Event) => void): void {
    }

    removeEventListener(_type: string, _listener: (event?: Event) => void): void {
    }

    getTransceivers(): Array<{ stop: () => void }> {
        return [];
    }

    close(): void {
        this.connectionState = 'closed';
    }

    restartIce(): void {
    }

    createDataChannel(_label: string): RTCDataChannel {
        return {} as RTCDataChannel;
    }

    addIceCandidate(_candidate?: RTCIceCandidateInit): Promise<void> {
        return Promise.resolve();
    }

    async setRemoteDescription(description: RTCSessionDescription): Promise<void> {
        this.remoteDescription = description;
        this.signalingState = description.type === 'offer'
            ? 'have-remote-offer'
            : 'stable';
    }

    async setLocalDescription(
        description?: RTCSessionDescriptionInit,
    ): Promise<void> {
        if (description) {
            this.localDescription = description as RTCSessionDescription;
        } else if (this.remoteDescription?.type === 'offer') {
            this.localDescription = {
                type: 'answer',
                sdp: 'answer-sdp',
            } as RTCSessionDescription;
        } else {
            this.localDescription = {
                type: 'offer',
                sdp: 'offer-sdp',
            } as RTCSessionDescription;
        }

        this.signalingState = this.localDescription.type === 'offer'
            ? 'have-local-offer'
            : 'stable';
    }
}

await main();
