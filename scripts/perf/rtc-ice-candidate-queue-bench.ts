import { QRtcPeerConnection } from '@shared/webrtc/QRtcPeerConnection.ts';

type BenchResult = Readonly<{
    run: number;
    durationMs: number;
    candidateCount: number;
    addedCandidates: number;
    remainingQueuedCandidates: number;
}>;

const OUT = readArg('--out') ??
    'tmp/perf/results/rtc-ice-candidate-queue.json';
const CANDIDATES = Number(readArg('--candidates') ?? '25000');
const RUNS = Number(readArg('--runs') ?? '5');

const writeLine = console.log.bind(console);
console.log = () => {
};
console.warn = () => {
};

class FakeRTCPeerConnection {
    addedCandidates = 0;

    addIceCandidate(_candidate?: RTCIceCandidateInit): Promise<void> {
        this.addedCandidates += 1;
        return Promise.resolve();
    }
}

const results: BenchResult[] = [];

for (let run = 1; run <= RUNS; run++) {
    const peer = new QRtcPeerConnection(
        {
            send: async () => {
            },
        },
        {
            sessionId: 'self',
            token: 'token',
            peerSessionId: 'peer',
            iceCandidates: {
                iceServers: [],
                expiresAtEpochMs: Date.now() + 60_000,
            },
            isPolite: true,
        },
    );
    const queuedCandidates = Array.from(
        { length: CANDIDATES },
        (_unused, index) => ({
            candidate: `candidate-${index}`,
            sdpMid: '0',
            sdpMLineIndex: 0,
        } satisfies RTCIceCandidateInit),
    );
    const status = peer.status as unknown as {
        iceCandidateQueue: RTCIceCandidateInit[];
    };
    status.iceCandidateQueue = queuedCandidates;
    const pc = new FakeRTCPeerConnection();
    const start = performance.now();

    await (peer as unknown as {
        flushIceCandidateQueue: (
            pc: Pick<RTCPeerConnection, 'addIceCandidate'>,
        ) => Promise<void>;
    }).flushIceCandidateQueue(pc);

    results.push({
        run,
        durationMs: performance.now() - start,
        candidateCount: CANDIDATES,
        addedCandidates: pc.addedCandidates,
        remainingQueuedCandidates: status.iceCandidateQueue.length,
    });
}

await Deno.writeTextFile(
    OUT,
    JSON.stringify({
        createdAt: new Date().toISOString(),
        input: {
            candidateCount: CANDIDATES,
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
