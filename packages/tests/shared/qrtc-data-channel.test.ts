import { describe, expect, it, vi } from 'vitest';
import { QRtcDataChannel } from '@shared/webrtc/QRtcDataChannel.ts';

describe('QRtcDataChannel', () => {
    it('creates an initiator channel, dispatches messages, and enforces send guards', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'room',
            },
        );
        const lifecycle: string[] = [];
        const typedMessages: unknown[] = [];
        const plainMessages: unknown[] = [];

        dataChannel.onRtcCallbacksDo('callbacks', {
            onOpen: async () => {
                lifecycle.push('open');
            },
            onClose: async () => {
                lifecycle.push('close');
            },
            onError: async () => {
                lifecycle.push('error');
            },
        });
        dataChannel.onRtcMessageDo(
            'typed',
            {
                onMessage: async (message) => {
                    typedMessages.push(message);
                },
            },
            'chat',
        );
        dataChannel.onRtcMessageDo('plain', {
            onMessage: async (message) => {
                plainMessages.push(message);
            },
        });

        expect(() => dataChannel.send({ nope: true })).toThrow(
            'Data channel not open',
        );

        dataChannel.connect(true);

        expect(peerConnection.createDataChannel).toHaveBeenCalledWith('room');
        expect(dataChannel.isReadyToConnect()).toBe(false);

        const createdChannel = peerConnection.createdChannels[0];
        createdChannel.readyState = 'open';
        await createdChannel.emitOpen();

        expect(dataChannel.isOpen()).toBe(true);

        await dataChannel.send({ hello: true });
        await dataChannel.sendAsJsonString('{"raw":true}');

        await createdChannel.emitMessage({
            type: 'chat',
            body: 'typed',
        });
        await createdChannel.emitMessage({
            body: 'plain',
        });
        await createdChannel.emitError();
        await createdChannel.emitClose();

        expect(createdChannel.sent).toEqual([
            JSON.stringify({ hello: true }),
            '{"raw":true}',
        ]);
        expect(typedMessages).toEqual([
            {
                type: 'chat',
                body: 'typed',
            },
            {
                body: 'plain',
            },
        ]);
        expect(plainMessages).toEqual([
            {
                body: 'plain',
            },
        ]);
        expect(lifecycle).toEqual(['open', 'error', 'close']);
    });

    it('waits for receiver-side channels, ignores mismatched labels, and resets cleanly', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'room',
            },
        );
        const opened: string[] = [];

        dataChannel.onRtcCallbacksDo('callbacks', {
            onOpen: async () => {
                opened.push('open');
            },
        });

        dataChannel.connect(false);

        expect(peerConnection.createDataChannel).not.toHaveBeenCalled();
        expect(peerConnection.onDataChannelCallback).toBeDefined();

        const wrong = new FakeRTCDataChannel('other');
        await peerConnection.onDataChannelCallback?.({
            channel: wrong,
        });

        expect(opened).toEqual([]);

        const matching = new FakeRTCDataChannel('room');
        await peerConnection.onDataChannelCallback?.({
            channel: matching,
        });

        matching.readyState = 'open';
        await matching.emitOpen();

        expect(opened).toEqual(['open']);
        expect(dataChannel.removeRtcCallbackById('callbacks')).toBe(true);
        expect(dataChannel.removeOnRtcMessageCallbackById('missing')).toBe(false);

        dataChannel.reset();

        expect(matching.close).toHaveBeenCalledOnce();
        expect(dataChannel.isReadyToConnect()).toBe(true);
    });

    it('registers receiver data-channel callbacks per lane', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {
        });
        const peerConnection = createPeerConnectionHarness();
        const reliable = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'rtc-data-channel',
            },
        );
        const realtime = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'rtc-realtime',
            },
        );

        reliable.connect(false);
        realtime.connect(false);

        expect(Array.from(peerConnection.onDataChannelCallbacks.keys())).toEqual([
            'peer-1:rtc-data-channel',
            'peer-1:rtc-realtime',
        ]);

        const incoming = new FakeRTCDataChannel('rtc-realtime');
        for (const callback of peerConnection.onDataChannelCallbacks.values()) {
            await callback({
                channel: incoming,
            });
        }

        expect(reliable.readHealth().readyState).toBeUndefined();
        expect(realtime.readHealth().readyState).toBe('connecting');
        expect(consoleError).not.toHaveBeenCalledWith(
            expect.stringContaining(
                'Received data channel for different data channel name',
            ),
        );
        consoleError.mockRestore();
    });

    it('waits until a connecting channel opens', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'room',
            },
        );

        dataChannel.connect(true);

        const wait = dataChannel.waitUntilOpen(1_000);
        const createdChannel = peerConnection.createdChannels[0];
        await createdChannel.emitOpen();

        await expect(wait).resolves.toBe(true);
        expect(dataChannel.isOpen()).toBe(true);
    });

    it('returns false when a channel open wait times out', async () => {
        vi.useFakeTimers();
        try {
            const peerConnection = createPeerConnectionHarness();
            const dataChannel = new QRtcDataChannel(
                peerConnection.peerConnection as never,
                {
                    peerId: 'peer-1',
                    dataChannelName: 'room',
                },
            );

            dataChannel.connect(true);

            const wait = dataChannel.waitUntilOpen(10);
            await vi.advanceTimersByTimeAsync(10);

            await expect(wait).resolves.toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('resolves pending open waits when reset before open', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'room',
            },
        );

        dataChannel.connect(false);

        const wait = dataChannel.waitUntilOpen(1_000);

        dataChannel.reset();

        await expect(wait).resolves.toBe(false);
        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Idle',
            readyState: undefined,
        });
    });

    it('resolves pending open waits when a channel closes before opening', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'room',
            },
        );
        const lifecycle: string[] = [];

        dataChannel.onRtcCallbacksDo('callbacks', {
            onClose: async () => {
                lifecycle.push('close');
            },
        });

        dataChannel.connect(true);

        const wait = dataChannel.waitUntilOpen(1_000);
        const createdChannel = peerConnection.createdChannels[0];

        await createdChannel.emitClose();

        await expect(wait).resolves.toBe(false);
        expect(lifecycle).toEqual(['close']);
        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Closed',
            readyState: undefined,
        });
        expect(createdChannel.onopen).toBeNull();
        expect(createdChannel.onclose).toBeNull();
    });

    it('clears stale closed channel state before later reconnect attempts', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'room',
            },
        );

        dataChannel.connect(true);

        const createdChannel = peerConnection.createdChannels[0];
        await createdChannel.emitOpen();
        await createdChannel.emitClose();

        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Closed',
            readyState: undefined,
        });
        expect(dataChannel.isReadyToConnect()).toBe(true);
        await expect(dataChannel.waitUntilOpen(1_000)).resolves.toBe(false);
    });

    it('replaces a failed initiator channel on reconnect', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'room',
            },
        );

        dataChannel.connect(true);

        const firstChannel = peerConnection.createdChannels[0];
        await firstChannel.emitError();

        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Failed',
            readyState: undefined,
        });
        expect(firstChannel.onopen).toBeNull();
        expect(firstChannel.onerror).toBeNull();

        dataChannel.connect(true);
        const wait = dataChannel.waitUntilOpen(1_000);

        expect(peerConnection.createDataChannel).toHaveBeenCalledTimes(2);
        expect(firstChannel.onopen).toBeNull();
        expect(firstChannel.onerror).toBeNull();

        const secondChannel = peerConnection.createdChannels[1];
        expect(secondChannel).not.toBe(firstChannel);

        await secondChannel.emitOpen();

        await expect(wait).resolves.toBe(true);
        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Open',
            readyState: 'open',
        });
    });

    it('replaces a closed initiator channel on reconnect', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'room',
            },
        );

        dataChannel.connect(true);

        const firstChannel = peerConnection.createdChannels[0];
        await firstChannel.emitOpen();
        await firstChannel.emitClose();

        dataChannel.connect(true);
        const wait = dataChannel.waitUntilOpen(1_000);

        expect(peerConnection.createDataChannel).toHaveBeenCalledTimes(2);

        const secondChannel = peerConnection.createdChannels[1];
        expect(secondChannel).not.toBe(firstChannel);

        await secondChannel.emitOpen();

        await expect(wait).resolves.toBe(true);
        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Open',
            readyState: 'open',
        });
    });

    it('drops queued sends when a native channel closes before reconnect', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'realtime',
                flowControl: {
                    highWatermarkBytes: 2,
                    lowWatermarkBytes: 1,
                    overflow: 'queue',
                    maxQueueItems: 2,
                },
            },
        );

        dataChannel.connect(true);

        const firstChannel = peerConnection.createdChannels[0];
        firstChannel.bufferedAmount = 2;
        await firstChannel.emitOpen();

        expect(dataChannel.sendJson({ seq: 1 })).toMatchObject({
            status: 'queued',
        });
        expect(dataChannel.sendJson({ seq: 2 })).toMatchObject({
            status: 'queued',
        });
        expect(dataChannel.readHealth().queuedItemCount).toBe(2);

        await firstChannel.emitClose();

        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Closed',
            readyState: undefined,
            queuedItemCount: 0,
        });

        dataChannel.connect(true);

        const secondChannel = peerConnection.createdChannels[1];
        await secondChannel.emitOpen();
        await secondChannel.emitBufferedAmountLow();

        expect(secondChannel.sent).toEqual([]);
        expect(dataChannel.readHealth().queuedItemCount).toBe(0);
    });

    it('drops queued sends when a native channel errors before reconnect', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'realtime',
                flowControl: {
                    highWatermarkBytes: 2,
                    lowWatermarkBytes: 1,
                    overflow: 'queue',
                    maxQueueItems: 2,
                },
            },
        );

        dataChannel.connect(true);

        const firstChannel = peerConnection.createdChannels[0];
        firstChannel.bufferedAmount = 2;
        await firstChannel.emitOpen();

        expect(dataChannel.sendJson({ seq: 1 })).toMatchObject({
            status: 'queued',
        });
        expect(dataChannel.sendJson({ seq: 2 })).toMatchObject({
            status: 'queued',
        });
        expect(dataChannel.readHealth().queuedItemCount).toBe(2);

        await firstChannel.emitError();

        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Failed',
            readyState: undefined,
            queuedItemCount: 0,
        });

        dataChannel.connect(true);

        const secondChannel = peerConnection.createdChannels[1];
        await secondChannel.emitOpen();
        await secondChannel.emitBufferedAmountLow();

        expect(secondChannel.sent).toEqual([]);
        expect(dataChannel.readHealth().queuedItemCount).toBe(0);
    });

    it('waits for a replacement receiver channel after the previous channel closed', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'room',
            },
        );

        dataChannel.connect(false);

        const firstChannel = new FakeRTCDataChannel('room');
        await peerConnection.onDataChannelCallback?.({
            channel: firstChannel,
        });
        await firstChannel.emitOpen();
        await firstChannel.emitClose();

        dataChannel.connect(false);
        const wait = dataChannel.waitUntilOpen(1_000);

        expect(peerConnection.createDataChannel).not.toHaveBeenCalled();

        const secondChannel = new FakeRTCDataChannel('room');
        await peerConnection.onDataChannelCallback?.({
            channel: secondChannel,
        });
        await secondChannel.emitOpen();

        await expect(wait).resolves.toBe(true);
        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Open',
            readyState: 'open',
        });
    });

    it('supports realtime lane options, binary sends, and replace-by-key back pressure', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannelInit = {
            ordered: false,
            maxRetransmits: 0,
        };
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'realtime',
                dataChannelInit,
                binaryType: 'arraybuffer',
                flowControl: {
                    highWatermarkBytes: 10,
                    lowWatermarkBytes: 2,
                    overflow: 'replace-by-key',
                    maxQueueItems: 4,
                },
            },
        );

        dataChannel.connect(true);

        expect(peerConnection.createDataChannel).toHaveBeenCalledWith(
            'realtime',
            dataChannelInit,
        );

        const createdChannel = peerConnection.createdChannels[0];
        expect(createdChannel.binaryType).toBe('arraybuffer');
        expect(createdChannel.bufferedAmountLowThreshold).toBe(2);

        createdChannel.readyState = 'open';
        await createdChannel.emitOpen();
        createdChannel.bufferedAmount = 10;

        expect(dataChannel.sendJson({ x: 1 }, { key: 'player' })).toMatchObject({
            status: 'queued',
            key: 'player',
            bufferedAmount: 10,
        });
        expect(dataChannel.sendJson({ x: 2 }, { key: 'player' })).toMatchObject({
            status: 'replaced',
            key: 'player',
            bufferedAmount: 10,
        });
        expect(createdChannel.sent).toEqual([]);

        createdChannel.bufferedAmount = 0;
        await createdChannel.emitBufferedAmountLow();

        const bytes = new Uint8Array([1, 2, 3]);
        expect(dataChannel.sendBinary(bytes)).toMatchObject({
            status: 'sent',
            bufferedAmount: 0,
        });
        expect(createdChannel.sent).toEqual([
            JSON.stringify({ x: 2 }),
            bytes,
        ]);
    });

    it('preserves queued order for indexed replace-by-key sends', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'realtime',
                flowControl: {
                    highWatermarkBytes: 2,
                    lowWatermarkBytes: 1,
                    overflow: 'replace-by-key',
                    maxQueueItems: 3,
                },
            },
        );

        dataChannel.connect(true);

        const createdChannel = peerConnection.createdChannels[0];
        createdChannel.readyState = 'open';
        createdChannel.bufferedAmount = 2;
        await createdChannel.emitOpen();

        expect(dataChannel.sendJson({ seq: 1 }, { key: 'a' })).toMatchObject({
            status: 'queued',
        });
        expect(dataChannel.sendJson({ seq: 2 }, { key: 'b' })).toMatchObject({
            status: 'queued',
        });
        expect(dataChannel.sendJson({ seq: 3 }, { key: 'c' })).toMatchObject({
            status: 'queued',
        });
        expect(dataChannel.sendJson({ seq: 4 }, { key: 'b' })).toMatchObject({
            status: 'replaced',
        });

        createdChannel.bufferedAmount = 0;
        await createdChannel.emitBufferedAmountLow();

        expect(createdChannel.sent).toEqual([
            JSON.stringify({ seq: 1 }),
            JSON.stringify({ seq: 4 }),
            JSON.stringify({ seq: 3 }),
        ]);
        expect(dataChannel.readHealth()).toMatchObject({
            queuedItemCount: 0,
            counters: {
                queued: 3,
                replaced: 1,
                flushed: 3,
                sent: 3,
            },
        });

        createdChannel.bufferedAmount = 2;
        expect(dataChannel.sendJson({ seq: 5 }, { key: 'b' })).toMatchObject({
            status: 'queued',
        });
        expect(dataChannel.sendJson({ seq: 6 }, { key: 'b' })).toMatchObject({
            status: 'replaced',
        });

        createdChannel.bufferedAmount = 0;
        await createdChannel.emitBufferedAmountLow();

        expect(createdChannel.sent).toEqual([
            JSON.stringify({ seq: 1 }),
            JSON.stringify({ seq: 4 }),
            JSON.stringify({ seq: 3 }),
            JSON.stringify({ seq: 6 }),
        ]);
    });

    it('dispatches raw messages without requiring JSON callbacks', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'room',
            },
        );
        const rawMessages: unknown[] = [];

        dataChannel.onRawMessageDo('raw', {
            onMessage: async (data) => {
                rawMessages.push(data);
            },
        });

        dataChannel.connect(true);

        const createdChannel = peerConnection.createdChannels[0];
        createdChannel.readyState = 'open';
        await createdChannel.emitOpen();
        await createdChannel.emitRawMessage('not-json');

        expect(rawMessages).toEqual(['not-json']);
    });

    it('reports health and applies drop-new pressure policy', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'realtime',
                flowControl: {
                    highWatermarkBytes: 4,
                    lowWatermarkBytes: 1,
                    overflow: 'drop-new',
                },
            },
        );

        dataChannel.connect(true);

        const createdChannel = peerConnection.createdChannels[0];
        createdChannel.readyState = 'open';
        createdChannel.bufferedAmount = 4;
        await createdChannel.emitOpen();

        expect(dataChannel.sendJson({ x: 1 })).toMatchObject({
            status: 'dropped',
            bufferedAmount: 4,
        });
        expect(dataChannel.readHealth()).toMatchObject({
            peerId: 'peer-1',
            label: 'realtime',
            state: 'Open',
            readyState: 'open',
            bufferedAmount: 4,
            queuedItemCount: 0,
            flowControl: {
                highWatermarkBytes: 4,
                lowWatermarkBytes: 1,
                overflow: 'drop-new',
            },
            counters: {
                dropped: 1,
                queued: 0,
                sent: 0,
            },
        });
    });

    it('drops stale queued sends when pressure clears', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'realtime',
                flowControl: {
                    highWatermarkBytes: 2,
                    lowWatermarkBytes: 1,
                    overflow: 'queue',
                    maxQueueItems: 2,
                },
            },
        );

        dataChannel.connect(true);

        const createdChannel = peerConnection.createdChannels[0];
        createdChannel.readyState = 'open';
        createdChannel.bufferedAmount = 2;
        await createdChannel.emitOpen();

        expect(
            dataChannel.sendJson(
                { stale: true },
                {
                    maxAgeMs: 1,
                    now: () => Date.now() - 10,
                },
            ),
        ).toMatchObject({
            status: 'queued',
        });

        createdChannel.bufferedAmount = 0;
        await createdChannel.emitBufferedAmountLow();

        expect(createdChannel.sent).toEqual([]);
        expect(dataChannel.readHealth()).toMatchObject({
            queuedItemCount: 0,
            counters: {
                queued: 1,
                droppedStale: 1,
                sent: 0,
            },
        });
    });

    it('drops the oldest queued item when configured to prefer newer sends', async () => {
        const peerConnection = createPeerConnectionHarness();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection as never,
            {
                peerId: 'peer-1',
                dataChannelName: 'realtime',
                flowControl: {
                    highWatermarkBytes: 2,
                    lowWatermarkBytes: 1,
                    overflow: 'drop-old',
                    maxQueueItems: 1,
                },
            },
        );

        dataChannel.connect(true);

        const createdChannel = peerConnection.createdChannels[0];
        createdChannel.readyState = 'open';
        createdChannel.bufferedAmount = 2;
        await createdChannel.emitOpen();

        expect(dataChannel.sendJson({ seq: 1 })).toMatchObject({
            status: 'queued',
        });
        expect(dataChannel.sendJson({ seq: 2 })).toMatchObject({
            status: 'queued',
        });

        createdChannel.bufferedAmount = 0;
        await createdChannel.emitBufferedAmountLow();

        expect(createdChannel.sent).toEqual([
            JSON.stringify({ seq: 2 }),
        ]);
        expect(dataChannel.readHealth()).toMatchObject({
            queuedItemCount: 0,
            counters: {
                queued: 2,
                droppedOldest: 1,
                flushed: 1,
                sent: 1,
            },
        });
    });
});

class FakeRTCDataChannel {
    readonly sent: Array<
        string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>
    > = [];
    readonly close = vi.fn(() => {
        this.readyState = 'closed';
    });
    readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    binaryType: BinaryType = 'blob';
    onmessage: ((event: MessageEvent) => void | Promise<void>) | null = null;
    onopen: (() => void | Promise<void>) | null = null;
    onclose: (() => void | Promise<void>) | null = null;
    onerror: (() => void | Promise<void>) | null = null;
    onbufferedamountlow: (() => void | Promise<void>) | null = null;

    public readonly label: string;

    constructor(label: string) {
        this.label = label;
    }

    send(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
        this.sent.push(data);
    }

    async emitOpen(): Promise<void> {
        this.readyState = 'open';
        await this.onopen?.();
    }

    async emitMessage(data: unknown): Promise<void> {
        await this.onmessage?.({
            data: JSON.stringify(data),
        } as MessageEvent);
    }

    async emitRawMessage(data: unknown): Promise<void> {
        await this.onmessage?.({
            data,
        } as MessageEvent);
    }

    async emitClose(): Promise<void> {
        this.readyState = 'closed';
        await this.onclose?.();
    }

    async emitError(): Promise<void> {
        this.readyState = 'closed';
        await this.onerror?.();
    }

    async emitBufferedAmountLow(): Promise<void> {
        await this.onbufferedamountlow?.();
    }
}

type FakeRTCDataChannelEvent = { channel: FakeRTCDataChannel };

function createPeerConnectionHarness() {
    let onDataChannelCallback:
        | ((event: FakeRTCDataChannelEvent) => Promise<void>)
        | undefined;
    const onDataChannelCallbacks = new Map<
        string,
        (event: FakeRTCDataChannelEvent) => Promise<void>
    >();
    const createdChannels: FakeRTCDataChannel[] = [];

    const peerConnection = {
        isReadyToConnect: vi.fn(() => true),
        onDataChannelDo: vi.fn(function (
            id: string,
            callback: (event: FakeRTCDataChannelEvent) => Promise<void>,
        ) {
            onDataChannelCallbacks.set(id, callback);
            onDataChannelCallback = callback;
            return peerConnection;
        }),
        createDataChannel: vi.fn((label: string, _init?: RTCDataChannelInit) => {
            const channel = new FakeRTCDataChannel(label);
            createdChannels.push(channel);
            return channel;
        }),
    };

    return {
        peerConnection,
        createDataChannel: peerConnection.createDataChannel,
        createdChannels,
        onDataChannelCallbacks,
        get onDataChannelCallback() {
            return onDataChannelCallback;
        },
    };
}
