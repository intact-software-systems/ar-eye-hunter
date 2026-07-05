import { QRtcDataChannel } from '@shared/webrtc/QRtcDataChannel.ts';

type BenchResult = Readonly<{
    run: number;
    fillDurationMs: number;
    replacementDurationMs: number;
    totalDurationMs: number;
    queueSize: number;
    replacements: number;
    queuedItemCount: number;
    sentCount: number;
    counters: Record<string, number>;
}>;

const OUT = readArg('--out') ??
    'tmp/perf/results/rtc-data-channel-replace-key.json';
const QUEUE_SIZE = Number(readArg('--queue-size') ?? '5000');
const REPLACEMENTS = Number(readArg('--replacements') ?? '25000');
const RUNS = Number(readArg('--runs') ?? '5');

const writeLine = console.log.bind(console);
console.log = () => {
};
console.warn = () => {
};

class FakeRTCDataChannel {
    readonly sent: Array<string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>> = [];
    readyState: RTCDataChannelState = 'connecting';
    bufferedAmount = 1;
    bufferedAmountLowThreshold = 0;
    binaryType: BinaryType = 'blob';
    onmessage: ((event: MessageEvent) => void | Promise<void>) | null = null;
    onopen: (() => void | Promise<void>) | null = null;
    onclose: (() => void | Promise<void>) | null = null;
    onerror: (() => void | Promise<void>) | null = null;
    onbufferedamountlow: (() => void | Promise<void>) | null = null;

    constructor(public readonly label: string) {
    }

    send(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
        this.sent.push(data);
    }

    close(): void {
        this.readyState = 'closed';
    }

    async emitOpen(): Promise<void> {
        this.readyState = 'open';
        await this.onopen?.();
    }
}

function createPeerConnectionHarness() {
    const createdChannels: FakeRTCDataChannel[] = [];
    const peerConnection = {
        onDataChannelDo: () => peerConnection,
        createDataChannel: (label: string, _init?: RTCDataChannelInit) => {
            const channel = new FakeRTCDataChannel(label);
            createdChannels.push(channel);
            return channel;
        },
    };

    return {
        peerConnection,
        createdChannels,
    };
}

async function createOpenBackPressuredChannel(): Promise<{
    dataChannel: QRtcDataChannel;
    rtcChannel: FakeRTCDataChannel;
}> {
    const harness = createPeerConnectionHarness();
    const dataChannel = new QRtcDataChannel(
        harness.peerConnection as never,
        {
            peerId: 'peer-1',
            dataChannelName: 'realtime',
            flowControl: {
                highWatermarkBytes: 1,
                lowWatermarkBytes: 0,
                overflow: 'replace-by-key',
                maxQueueItems: QUEUE_SIZE,
            },
        },
    );

    dataChannel.connect(true);
    const rtcChannel = harness.createdChannels[0];
    await rtcChannel.emitOpen();
    rtcChannel.bufferedAmount = 1;

    return { dataChannel, rtcChannel };
}

function payload(sequence: number): Record<string, number> {
    return {
        sequence,
        x: sequence % 1024,
        y: sequence % 2048,
    };
}

const results: BenchResult[] = [];

for (let run = 1; run <= RUNS; run++) {
    const { dataChannel, rtcChannel } = await createOpenBackPressuredChannel();
    const totalStart = performance.now();
    const fillStart = performance.now();

    for (let index = 0; index < QUEUE_SIZE; index++) {
        const result = dataChannel.sendJson(payload(index), {
            key: `entity-${index}`,
            now: () => 1_700_000_000_000,
        });
        if (result.status !== 'queued') {
            throw new Error(`Expected queued during fill, received ${result.status}`);
        }
    }

    const fillDurationMs = performance.now() - fillStart;
    const replacementStart = performance.now();

    for (let index = 0; index < REPLACEMENTS; index++) {
        const keyIndex = index % QUEUE_SIZE;
        const result = dataChannel.sendJson(payload(index + QUEUE_SIZE), {
            key: `entity-${keyIndex}`,
            now: () => 1_700_000_000_000 + index + 1,
        });
        if (result.status !== 'replaced') {
            throw new Error(
                `Expected replaced during replacements, received ${result.status}`,
            );
        }
    }

    const replacementDurationMs = performance.now() - replacementStart;
    const health = dataChannel.readHealth();
    results.push({
        run,
        fillDurationMs,
        replacementDurationMs,
        totalDurationMs: performance.now() - totalStart,
        queueSize: QUEUE_SIZE,
        replacements: REPLACEMENTS,
        queuedItemCount: health.queuedItemCount,
        sentCount: rtcChannel.sent.length,
        counters: health.counters as unknown as Record<string, number>,
    });
}

await Deno.writeTextFile(
    OUT,
    JSON.stringify({
        createdAt: new Date().toISOString(),
        input: {
            queueSize: QUEUE_SIZE,
            replacements: REPLACEMENTS,
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
