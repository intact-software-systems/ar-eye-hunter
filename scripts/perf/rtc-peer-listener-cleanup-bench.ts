import { QRtcPeerConnection } from '@shared/webrtc/QRtcPeerConnection.ts';

type Listener = (event?: Event) => void;

type BenchResult = Readonly<{
    run: number;
    durationMs: number;
    peerCount: number;
    retainedIceGatheringListeners: number;
    maxListenersPerPeer: number;
    unclearedHandlerSlots: number;
}>;

const OUT = readArg('--out') ??
    'tmp/perf/results/rtc-peer-listener-cleanup.json';
const PEERS = Number(readArg('--peers') ?? '10000');
const RUNS = Number(readArg('--runs') ?? '5');
const writeLine = console.log.bind(console);

console.log = () => {
};

class FakeRTCPeerConnection {
    static instances: FakeRTCPeerConnection[] = [];

    connectionState: RTCPeerConnectionState = 'new';
    signalingState: RTCSignalingState = 'stable';
    iceConnectionState: RTCIceConnectionState = 'new';
    iceGatheringState: RTCIceGatheringState = 'new';
    localDescription: RTCSessionDescription | null = null;

    onnegotiationneeded: (() => Promise<void>) | null = null;
    onicecandidate:
        | ((event: { candidate: RTCIceCandidateInit | null }) => Promise<void>)
        | null = null;
    ondatachannel: ((event: RTCDataChannelEvent) => Promise<void>) | null = null;
    ontrack: ((event: RTCTrackEvent) => Promise<void>) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    onsignalingstatechange: (() => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;

    private readonly listeners = new Map<string, Listener[]>();

    constructor(_configuration: RTCConfiguration) {
        FakeRTCPeerConnection.instances.push(this);
    }

    addEventListener(type: string, listener: Listener): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: Listener): void {
        const listeners = this.listeners.get(type);
        if (!listeners) {
            return;
        }

        const index = listeners.indexOf(listener);
        if (index >= 0) {
            listeners.splice(index, 1);
        }
        if (listeners.length === 0) {
            this.listeners.delete(type);
        }
    }

    listenerCount(type: string): number {
        return this.listeners.get(type)?.length ?? 0;
    }

    unclearedHandlerSlotCount(): number {
        return [
            this.onnegotiationneeded,
            this.onicecandidate,
            this.ondatachannel,
            this.ontrack,
            this.oniceconnectionstatechange,
            this.onsignalingstatechange,
            this.onconnectionstatechange,
        ].filter((handler) => handler !== null).length;
    }

    getTransceivers(): Array<{ stop: () => void }> {
        return [];
    }

    createDataChannel(_label: string): RTCDataChannel {
        return {} as RTCDataChannel;
    }

    close(): void {
        this.connectionState = 'closed';
    }

    setLocalDescription(): Promise<void> {
        this.localDescription = {
            type: 'offer',
            sdp: 'offer-sdp',
            toJSON: () => ({ type: 'offer', sdp: 'offer-sdp' }),
        };
        return Promise.resolve();
    }
}

(globalThis as unknown as { RTCPeerConnection: typeof FakeRTCPeerConnection })
    .RTCPeerConnection = FakeRTCPeerConnection;

const results: BenchResult[] = [];

for (let run = 1; run <= RUNS; run++) {
    FakeRTCPeerConnection.instances = [];
    const start = performance.now();

    for (let index = 0; index < PEERS; index++) {
        const peer = new QRtcPeerConnection(
            {
                send: async () => {
                },
            },
            {
                sessionId: `self-${index}`,
                token: 'token',
                peerSessionId: `peer-${index}`,
                iceCandidates: {
                    iceServers: [],
                    expiresAtEpochMs: Date.now() + 60_000,
                },
                isPolite: true,
            },
        );
        peer.connect();
        peer.reset();
    }

    const durationMs = performance.now() - start;
    const retainedIceGatheringListeners = FakeRTCPeerConnection.instances
        .reduce(
            (sum, pc) => sum + pc.listenerCount('icegatheringstatechange'),
            0,
        );
    results.push({
        run,
        durationMs,
        peerCount: PEERS,
        retainedIceGatheringListeners,
        maxListenersPerPeer: Math.max(
            ...FakeRTCPeerConnection.instances.map((pc) =>
                pc.listenerCount('icegatheringstatechange')
            ),
        ),
        unclearedHandlerSlots: FakeRTCPeerConnection.instances.reduce(
            (sum, pc) => sum + pc.unclearedHandlerSlotCount(),
            0,
        ),
    });
}

await Deno.writeTextFile(
    OUT,
    JSON.stringify({
        createdAt: new Date().toISOString(),
        input: {
            peerCount: PEERS,
            runs: RUNS,
        },
        results,
    }, null, 2),
);

writeLine(`Wrote ${OUT}`);

function readArg(name: string): string | undefined {
    return Deno.args.find((arg) => arg.startsWith(`${name}=`))
        ?.slice(name.length + 1);
}
