import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { QRtcDataChannel } from '../../../packages/shared/webrtc/QRtcDataChannel.ts';

type Args = Readonly<{
    queueItems: number;
    runs: number;
    out: string;
}>;

type RunResult = Readonly<{
    run: number;
    queueItems: number;
    durationMs: number;
    queuedBeforeClose: number;
    queuedAfterNativeClose: number;
    queuedAfterReconnect: number;
    replacementSentCount: number;
    staleFlushOnReconnect: boolean;
}>;

class FakeRTCDataChannel {
    readonly sent: Array<string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>> = [];
    readyState: RTCDataChannelState = 'connecting';
    bufferedAmount = 0;
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

    async emitClose(): Promise<void> {
        this.readyState = 'closed';
        await this.onclose?.();
    }

    async emitBufferedAmountLow(): Promise<void> {
        await this.onbufferedamountlow?.();
    }
}

function createPeerConnectionHarness() {
    const createdChannels: FakeRTCDataChannel[] = [];
    const peerConnection = {
        isReadyToConnect: () => true,
        onDataChannelDo: function () {
            return peerConnection;
        },
        createDataChannel: (label: string) => {
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

function parseArgs(): Args {
    const args = process.argv.slice(2);
    const readValue = (name: string, fallback: string) => {
        const prefix = `--${name}=`;
        return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
    };

    return {
        queueItems: Number(readValue('queue-items', '32')),
        runs: Number(readValue('runs', '3')),
        out: readValue(
            'out',
            'tmp/perf/results/rtc-data-channel-close-retention.json',
        ),
    };
}

async function runOnce(run: number, queueItems: number): Promise<RunResult> {
    const start = performance.now();
    const peerConnection = createPeerConnectionHarness();
    const dataChannel = new QRtcDataChannel(
        peerConnection.peerConnection as never,
        {
            peerId: 'perf-peer',
            dataChannelName: 'realtime',
            flowControl: {
                highWatermarkBytes: 1,
                lowWatermarkBytes: 0,
                overflow: 'queue',
                maxQueueItems: queueItems,
            },
        },
    );

    dataChannel.connect(true);
    const firstChannel = peerConnection.createdChannels[0];
    firstChannel.bufferedAmount = 1;
    await firstChannel.emitOpen();

    for (let i = 0; i < queueItems; i += 1) {
        dataChannel.sendJson({ seq: i });
    }

    const queuedBeforeClose = dataChannel.readHealth().queuedItemCount;
    await firstChannel.emitClose();
    const queuedAfterNativeClose = dataChannel.readHealth().queuedItemCount;

    dataChannel.connect(true);
    const replacementChannel = peerConnection.createdChannels[1];
    await replacementChannel.emitOpen();
    replacementChannel.bufferedAmount = 0;
    await replacementChannel.emitBufferedAmountLow();

    const queuedAfterReconnect = dataChannel.readHealth().queuedItemCount;
    const replacementSentCount = replacementChannel.sent.length;

    return {
        run,
        queueItems,
        durationMs: performance.now() - start,
        queuedBeforeClose,
        queuedAfterNativeClose,
        queuedAfterReconnect,
        replacementSentCount,
        staleFlushOnReconnect: replacementSentCount > 0,
    };
}

const args = parseArgs();
const results: RunResult[] = [];

for (let run = 1; run <= args.runs; run += 1) {
    results.push(await runOnce(run, args.queueItems));
}

const output = {
    command: process.argv.join(' '),
    queueItems: args.queueItems,
    runs: args.runs,
    results,
};

mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
