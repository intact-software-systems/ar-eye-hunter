import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { QRtcDataChannel } from '../../../packages/shared/webrtc/QRtcDataChannel.ts';

type Args = Readonly<{
    runs: number;
    out: string;
}>;

type RunResult = Readonly<{
    run: number;
    durationMs: number;
    readyStateAfterError: RTCDataChannelState | undefined;
    statusHasDataChannelAfterError: boolean;
    attachedHandlerCountAfterError: number;
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

    async emitError(): Promise<void> {
        this.readyState = 'closed';
        await this.onerror?.();
    }

    attachedHandlerCount(): number {
        return [
            this.onmessage,
            this.onopen,
            this.onclose,
            this.onerror,
            this.onbufferedamountlow,
        ].filter((handler) => handler !== null).length;
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
        runs: Number(readValue('runs', '3')),
        out: readValue(
            'out',
            'tmp/perf/results/rtc-data-channel-error-reference.json',
        ),
    };
}

async function runOnce(run: number): Promise<RunResult> {
    const start = performance.now();
    const peerConnection = createPeerConnectionHarness();
    const dataChannel = new QRtcDataChannel(
        peerConnection.peerConnection as never,
        {
            peerId: 'perf-peer',
            dataChannelName: 'realtime',
        },
    );

    dataChannel.connect(true);
    const nativeChannel = peerConnection.createdChannels[0];
    await nativeChannel.emitOpen();
    await nativeChannel.emitError();

    return {
        run,
        durationMs: performance.now() - start,
        readyStateAfterError: dataChannel.readHealth().readyState,
        statusHasDataChannelAfterError: dataChannel.status.dc !== undefined,
        attachedHandlerCountAfterError: nativeChannel.attachedHandlerCount(),
    };
}

const args = parseArgs();
const results: RunResult[] = [];

for (let run = 1; run <= args.runs; run += 1) {
    results.push(await runOnce(run));
}

const output = {
    command: process.argv.join(' '),
    runs: args.runs,
    results,
};

mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
