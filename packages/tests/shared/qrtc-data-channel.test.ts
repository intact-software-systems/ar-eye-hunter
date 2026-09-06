import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import { installNativeRtcRuntime, NativeRtcRuntime, SimulatedNativeRtcPeerConnection } from './native-rtc-connection-fixture.ts';

let runtime: NativeRtcRuntime;
const peers: QRtcPeerConnection[] = [];

beforeEach(() => {
    runtime = installNativeRtcRuntime();
});

afterEach(() => {
    for (const peer of peers.splice(0)) {
        peer.reset();
    }
    runtime.dispose();
    vi.restoreAllMocks();
});

describe('QRtcDataChannel', () => {
    it('bounds decoded subscriptions before parsing while preserving the raw lane', async () => {
        const fixture = createNativeDataChannelFixture();
        const channel = new QRtcDataChannel(fixture.peerConnection, { peerId: 'peer-1', dataChannelName: 'room' });
        const rejected: string[] = [];
        const raw: unknown[] = [];
        const decoded: unknown[] = [];
        channel.onRtcMessageDo('alm', {
            maxMessageBytes: 4,
            onRejected: async (reason) => {
                rejected.push(reason.code);
            },
            onMessage: async (value) => {
                decoded.push(value);
            }
        });
        channel.onRawMessageDo('raw', {
            onMessage: async (value) => {
                raw.push(value);
            }
        });
        channel.connect(true);
        const native = fixture.native.channels[0];
        await native.open();
        const parse = vi.spyOn(JSON, 'parse');
        const binary = new ArrayBuffer(5);
        await native.receive('"éé"');
        await native.receive(binary);
        expect(parse.mock.calls.some(([value]) => value === '"éé"')).toBe(false);
        expect(rejected).toEqual(['oversized', 'oversized']);
        expect(raw).toEqual(['"éé"', binary]);
        expect(decoded).toEqual([]);
        await native.receive('"é"');
        expect(decoded).toEqual(['é']);
    });

    it('creates an initiator channel, dispatches messages, and enforces send guards', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'room'
            }
        );
        const lifecycle: string[] = [];
        const typedMessages: string[] = [];
        const plainMessages: string[] = [];

        dataChannel.onRtcCallbacksDo('callbacks', {
            onOpen: async () => {
                lifecycle.push('open');
            },
            onClose: async () => {
                lifecycle.push('close');
            },
            onError: async () => {
                lifecycle.push('error');
            }
        });
        dataChannel.onRtcMessageDo(
            'typed',
            {
                onMessage: async (message) => {
                    typedMessages.push(JSON.stringify(message));
                }
            },
            'chat'
        );
        dataChannel.onRtcMessageDo('plain', {
            onMessage: async (message) => {
                plainMessages.push(JSON.stringify(message));
            }
        });

        expect(dataChannel.sendJson({ nope: true })).toMatchObject({
            status: 'closed',
            reason: 'Data channel not open'
        });

        dataChannel.connect(true);

        expect(peerConnection.native.channels.map((channel) => channel.label)).toEqual(['room']);
        expect(dataChannel.isReadyToConnect()).toBe(false);

        const createdChannel = peerConnection.native.channels[0];
        createdChannel.readyState = 'open';
        await createdChannel.open();

        expect(dataChannel.isOpen()).toBe(true);

        expect(dataChannel.sendJson({ hello: true }).status).toBe('sent');
        expect(dataChannel.sendRaw('{"raw":true}').status).toBe('sent');

        await createdChannel.receive('{"type":"chat","body":"typed"}');
        await createdChannel.receive('{"body":"plain"}');
        await createdChannel.fail();
        await createdChannel.close();

        expect(createdChannel.sent).toEqual([
            JSON.stringify({ hello: true }),
            '{"raw":true}'
        ]);
        expect(typedMessages).toEqual(['{"type":"chat","body":"typed"}', '{"body":"plain"}']);
        expect(plainMessages).toEqual(['{"body":"plain"}']);
        expect(lifecycle).toEqual(['open', 'error', 'close']);
    });

    it('waits for receiver-side channels, ignores mismatched labels, and resets cleanly', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'room'
            }
        );
        const opened: string[] = [];

        dataChannel.onRtcCallbacksDo('callbacks', {
            onOpen: async () => {
                opened.push('open');
            }
        });

        dataChannel.connect(false);

        expect(peerConnection.native.channels).toEqual([]);

        const wrong = await peerConnection.native.receiveDataChannel('other');

        expect(opened).toEqual([]);

        const matching = await peerConnection.native.receiveDataChannel('room');

        matching.readyState = 'open';
        await matching.open();

        expect(opened).toEqual(['open']);
        expect(dataChannel.removeRtcCallbackById('callbacks')).toBe(true);
        expect(dataChannel.removeOnRtcMessageCallbackById('missing')).toBe(false);

        dataChannel.reset();

        expect(matching.readyState).toBe('closed');
        expect(dataChannel.isReadyToConnect()).toBe(true);
    });

    it('routes native receiver channels only to their matching lanes', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const reliable = new QRtcDataChannel(peerConnection.peerConnection, {
            peerId: 'peer-1',
            dataChannelName: 'rtc-data-channel'
        });
        const realtime = new QRtcDataChannel(peerConnection.peerConnection, {
            peerId: 'peer-1',
            dataChannelName: 'rtc-realtime'
        });
        reliable.connect(false);
        realtime.connect(false);
        const incoming = await peerConnection.native.receiveDataChannel('rtc-realtime');
        await incoming.open();

        expect(reliable.readHealth().readyState).toBeUndefined();
        expect(realtime.isOpen()).toBe(true);
        expect(realtime.sendJson({ lane: 'realtime' }).status).toBe('sent');
        expect(incoming.sent).toEqual(['{"lane":"realtime"}']);
    });

    it('does not reactivate a reset receiver until it connects again', async () => {
        const { peerConnection, native } = createNativeDataChannelFixture();
        const channel = new QRtcDataChannel(peerConnection, { peerId: 'peer-1', dataChannelName: 'room' });
        channel.connect(false);
        channel.reset();
        const ignored = await native.receiveDataChannel('room');
        await ignored.open();
        expect(channel.readHealth()).toMatchObject({ state: 'Idle', readyState: undefined });
        expect(channel.sendJson({ stale: true }).status).toBe('closed');

        channel.connect(false);
        const active = await native.receiveDataChannel('room');
        await active.open();
        expect(channel.sendJson({ current: true }).status).toBe('sent');
        expect(active.sent).toEqual(['{"current":true}']);
        expect(ignored.sent).toEqual([]);
    });

    it('isolates rejected open observers and still completes other observers', async () => {
        const { peerConnection, native } = createNativeDataChannelFixture();
        const channel = new QRtcDataChannel(peerConnection, { peerId: 'peer-1', dataChannelName: 'room' });
        const observed: string[] = [];
        vi.spyOn(console, 'error').mockImplementation(() => {});
        channel.onRtcCallbacksDo('rejected', {
            onOpen: async () => {
                throw new Error('Rejected open observer');
            }
        });
        channel.onRtcCallbacksDo('accepted', {
            onOpen: async () => {
                observed.push('open');
            }
        });
        channel.connect(true);
        await native.channels[0].open();
        expect(observed).toEqual(['open']);
        expect(channel.isOpen()).toBe(true);
    });

    it('waits until a connecting channel opens', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'room'
            }
        );

        dataChannel.connect(true);

        const wait = dataChannel.waitUntilOpen(1_000);
        const createdChannel = peerConnection.native.channels[0];
        await createdChannel.open();

        await expect(wait).resolves.toBe(true);
        expect(dataChannel.isOpen()).toBe(true);
    });

    it('returns false when a channel open wait times out', async () => {
        vi.useFakeTimers();
        try {
            const peerConnection = createNativeDataChannelFixture();
            const dataChannel = new QRtcDataChannel(
                peerConnection.peerConnection,
                {
                    peerId: 'peer-1',
                    dataChannelName: 'room'
                }
            );

            dataChannel.connect(true);

            const wait = dataChannel.waitUntilOpen(10);
            await vi.advanceTimersByTimeAsync(10);

            await expect(wait).resolves.toBe(false);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('resolves pending open waits when reset before open', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'room'
            }
        );

        dataChannel.connect(false);

        const wait = dataChannel.waitUntilOpen(1_000);

        dataChannel.reset();

        await expect(wait).resolves.toBe(false);
        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Idle',
            readyState: undefined
        });
    });

    it('resolves pending open waits when a channel closes before opening', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'room'
            }
        );
        const lifecycle: string[] = [];

        dataChannel.onRtcCallbacksDo('callbacks', {
            onClose: async () => {
                lifecycle.push('close');
            }
        });

        dataChannel.connect(true);

        const wait = dataChannel.waitUntilOpen(1_000);
        const createdChannel = peerConnection.native.channels[0];

        await createdChannel.close();

        await expect(wait).resolves.toBe(false);
        expect(lifecycle).toEqual(['close']);
        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Closed',
            readyState: undefined
        });
        expect(createdChannel.onopen).toBeNull();
        expect(createdChannel.onclose).toBeNull();
    });

    it('clears stale closed channel state before later reconnect attempts', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'room'
            }
        );

        dataChannel.connect(true);

        const createdChannel = peerConnection.native.channels[0];
        await createdChannel.open();
        await createdChannel.close();

        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Closed',
            readyState: undefined
        });
        expect(dataChannel.isReadyToConnect()).toBe(true);
        await expect(dataChannel.waitUntilOpen(1_000)).resolves.toBe(false);
    });

    it('replaces a failed initiator channel on reconnect', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'room'
            }
        );

        dataChannel.connect(true);

        const firstChannel = peerConnection.native.channels[0];
        await firstChannel.fail();

        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Failed',
            readyState: undefined
        });
        expect(firstChannel.onopen).toBeNull();
        expect(firstChannel.onerror).toBeNull();

        dataChannel.connect(true);
        const wait = dataChannel.waitUntilOpen(1_000);

        expect(peerConnection.native.channels).toHaveLength(2);
        expect(firstChannel.onopen).toBeNull();
        expect(firstChannel.onerror).toBeNull();

        const secondChannel = peerConnection.native.channels[1];
        expect(secondChannel).not.toBe(firstChannel);

        await secondChannel.open();

        await expect(wait).resolves.toBe(true);
        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Open',
            readyState: 'open'
        });
    });

    it('replaces a closed initiator channel on reconnect', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'room'
            }
        );

        dataChannel.connect(true);

        const firstChannel = peerConnection.native.channels[0];
        await firstChannel.open();
        await firstChannel.close();

        dataChannel.connect(true);
        const wait = dataChannel.waitUntilOpen(1_000);

        expect(peerConnection.native.channels).toHaveLength(2);

        const secondChannel = peerConnection.native.channels[1];
        expect(secondChannel).not.toBe(firstChannel);

        await secondChannel.open();

        await expect(wait).resolves.toBe(true);
        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Open',
            readyState: 'open'
        });
    });

    it('drops queued sends when a native channel closes before reconnect', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'realtime',
                flowControl: {
                    highWatermarkBytes: 2,
                    lowWatermarkBytes: 1,
                    overflow: 'queue',
                    maxQueueItems: 2
                }
            }
        );

        dataChannel.connect(true);

        const firstChannel = peerConnection.native.channels[0];
        firstChannel.bufferedAmount = 2;
        await firstChannel.open();

        expect(dataChannel.sendJson({ seq: 1 })).toMatchObject({
            status: 'queued'
        });
        expect(dataChannel.sendJson({ seq: 2 })).toMatchObject({
            status: 'queued'
        });
        expect(dataChannel.readHealth().queuedItemCount).toBe(2);

        await firstChannel.close();

        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Closed',
            readyState: undefined,
            queuedItemCount: 0
        });

        dataChannel.connect(true);

        const secondChannel = peerConnection.native.channels[1];
        await secondChannel.open();
        await secondChannel.drain();

        expect(secondChannel.sent).toEqual([]);
        expect(dataChannel.readHealth().queuedItemCount).toBe(0);
    });

    it('drops queued sends when a native channel errors before reconnect', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'realtime',
                flowControl: {
                    highWatermarkBytes: 2,
                    lowWatermarkBytes: 1,
                    overflow: 'queue',
                    maxQueueItems: 2
                }
            }
        );

        dataChannel.connect(true);

        const firstChannel = peerConnection.native.channels[0];
        firstChannel.bufferedAmount = 2;
        await firstChannel.open();

        expect(dataChannel.sendJson({ seq: 1 })).toMatchObject({
            status: 'queued'
        });
        expect(dataChannel.sendJson({ seq: 2 })).toMatchObject({
            status: 'queued'
        });
        expect(dataChannel.readHealth().queuedItemCount).toBe(2);

        await firstChannel.fail();

        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Failed',
            readyState: undefined,
            queuedItemCount: 0
        });

        dataChannel.connect(true);

        const secondChannel = peerConnection.native.channels[1];
        await secondChannel.open();
        await secondChannel.drain();

        expect(secondChannel.sent).toEqual([]);
        expect(dataChannel.readHealth().queuedItemCount).toBe(0);
    });

    it('waits for a replacement receiver channel after the previous channel closed', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'room'
            }
        );

        dataChannel.connect(false);

        const firstChannel = await peerConnection.native.receiveDataChannel('room');
        await firstChannel.open();
        await firstChannel.close();

        dataChannel.connect(false);
        const wait = dataChannel.waitUntilOpen(1_000);

        expect(peerConnection.native.channels).toEqual([firstChannel]);

        const secondChannel = await peerConnection.native.receiveDataChannel('room');
        await secondChannel.open();

        await expect(wait).resolves.toBe(true);
        expect(dataChannel.readHealth()).toMatchObject({
            state: 'Open',
            readyState: 'open'
        });
    });

    it('supports realtime lane options, binary sends, and replace-by-key back pressure', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannelInit = {
            ordered: false,
            maxRetransmits: 0
        };
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'realtime',
                dataChannelInit,
                binaryType: 'arraybuffer',
                flowControl: {
                    highWatermarkBytes: 10,
                    lowWatermarkBytes: 2,
                    overflow: 'replace-by-key',
                    maxQueueItems: 4
                }
            }
        );

        dataChannel.connect(true);

        expect(peerConnection.native.channels[0]).toMatchObject({ label: 'realtime', ordered: false, maxRetransmits: 0 });

        const createdChannel = peerConnection.native.channels[0];
        expect(createdChannel.binaryType).toBe('arraybuffer');
        expect(createdChannel.bufferedAmountLowThreshold).toBe(2);

        createdChannel.readyState = 'open';
        await createdChannel.open();
        createdChannel.bufferedAmount = 10;

        expect(dataChannel.sendJson({ x: 1 }, { key: 'player' })).toMatchObject({
            status: 'queued',
            key: 'player',
            bufferedAmount: 10
        });
        expect(dataChannel.sendJson({ x: 2 }, { key: 'player' })).toMatchObject({
            status: 'replaced',
            key: 'player',
            bufferedAmount: 10
        });
        expect(createdChannel.sent).toEqual([]);

        createdChannel.bufferedAmount = 0;
        await createdChannel.drain();

        const bytes = new Uint8Array([1, 2, 3]);
        expect(dataChannel.sendBinary(bytes)).toMatchObject({
            status: 'sent',
            bufferedAmount: 0
        });
        expect(createdChannel.sent).toEqual([
            JSON.stringify({ x: 2 }),
            bytes
        ]);
    });

    it('preserves queued order for indexed replace-by-key sends', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'realtime',
                flowControl: {
                    highWatermarkBytes: 2,
                    lowWatermarkBytes: 1,
                    overflow: 'replace-by-key',
                    maxQueueItems: 3
                }
            }
        );

        dataChannel.connect(true);

        const createdChannel = peerConnection.native.channels[0];
        createdChannel.readyState = 'open';
        createdChannel.bufferedAmount = 2;
        await createdChannel.open();

        expect(dataChannel.sendJson({ seq: 1 }, { key: 'a' })).toMatchObject({
            status: 'queued'
        });
        expect(dataChannel.sendJson({ seq: 2 }, { key: 'b' })).toMatchObject({
            status: 'queued'
        });
        expect(dataChannel.sendJson({ seq: 3 }, { key: 'c' })).toMatchObject({
            status: 'queued'
        });
        expect(dataChannel.sendJson({ seq: 4 }, { key: 'b' })).toMatchObject({
            status: 'replaced'
        });

        createdChannel.bufferedAmount = 0;
        await createdChannel.drain();

        expect(createdChannel.sent).toEqual([
            JSON.stringify({ seq: 1 }),
            JSON.stringify({ seq: 4 }),
            JSON.stringify({ seq: 3 })
        ]);
        expect(dataChannel.readHealth()).toMatchObject({
            queuedItemCount: 0,
            counters: {
                queued: 3,
                replaced: 1,
                flushed: 3,
                sent: 3
            }
        });

        createdChannel.bufferedAmount = 2;
        expect(dataChannel.sendJson({ seq: 5 }, { key: 'b' })).toMatchObject({
            status: 'queued'
        });
        expect(dataChannel.sendJson({ seq: 6 }, { key: 'b' })).toMatchObject({
            status: 'replaced'
        });

        createdChannel.bufferedAmount = 0;
        await createdChannel.drain();

        expect(createdChannel.sent).toEqual([
            JSON.stringify({ seq: 1 }),
            JSON.stringify({ seq: 4 }),
            JSON.stringify({ seq: 3 }),
            JSON.stringify({ seq: 6 })
        ]);
    });

    it('dispatches raw messages without requiring JSON callbacks', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'room'
            }
        );
        const rawMessages: string[] = [];

        dataChannel.onRawMessageDo('raw', {
            onMessage: async (data) => {
                if (typeof data !== 'string') {
                    throw new Error('Expected text at the raw receiver');
                }
                rawMessages.push(data);
            }
        });

        dataChannel.connect(true);

        const createdChannel = peerConnection.native.channels[0];
        createdChannel.readyState = 'open';
        await createdChannel.open();
        await createdChannel.receive('not-json');

        expect(rawMessages).toEqual(['not-json']);
    });

    it('reports health and applies drop-new pressure policy', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'realtime',
                flowControl: {
                    highWatermarkBytes: 4,
                    lowWatermarkBytes: 1,
                    overflow: 'drop-new'
                }
            }
        );

        dataChannel.connect(true);

        const createdChannel = peerConnection.native.channels[0];
        createdChannel.readyState = 'open';
        createdChannel.bufferedAmount = 4;
        await createdChannel.open();

        expect(dataChannel.sendJson({ x: 1 })).toMatchObject({
            status: 'dropped',
            bufferedAmount: 4
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
                overflow: 'drop-new'
            },
            counters: {
                dropped: 1,
                queued: 0,
                sent: 0
            }
        });
    });

    it('drops stale queued sends when pressure clears', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'realtime',
                flowControl: {
                    highWatermarkBytes: 2,
                    lowWatermarkBytes: 1,
                    overflow: 'queue',
                    maxQueueItems: 2
                }
            }
        );

        dataChannel.connect(true);

        const createdChannel = peerConnection.native.channels[0];
        createdChannel.readyState = 'open';
        createdChannel.bufferedAmount = 2;
        await createdChannel.open();

        expect(
            dataChannel.sendJson(
                { stale: true },
                {
                    maxAgeMs: 1,
                    now: () => Date.now() - 10
                }
            )
        ).toMatchObject({
            status: 'queued'
        });

        createdChannel.bufferedAmount = 0;
        await createdChannel.drain();

        expect(createdChannel.sent).toEqual([]);
        expect(dataChannel.readHealth()).toMatchObject({
            queuedItemCount: 0,
            counters: {
                queued: 1,
                droppedStale: 1,
                sent: 0
            }
        });
    });

    it('drops the oldest queued item when configured to prefer newer sends', async () => {
        const peerConnection = createNativeDataChannelFixture();
        const dataChannel = new QRtcDataChannel(
            peerConnection.peerConnection,
            {
                peerId: 'peer-1',
                dataChannelName: 'realtime',
                flowControl: {
                    highWatermarkBytes: 2,
                    lowWatermarkBytes: 1,
                    overflow: 'drop-old',
                    maxQueueItems: 1
                }
            }
        );

        dataChannel.connect(true);

        const createdChannel = peerConnection.native.channels[0];
        createdChannel.readyState = 'open';
        createdChannel.bufferedAmount = 2;
        await createdChannel.open();

        expect(dataChannel.sendJson({ seq: 1 })).toMatchObject({
            status: 'queued'
        });
        expect(dataChannel.sendJson({ seq: 2 })).toMatchObject({
            status: 'queued'
        });

        createdChannel.bufferedAmount = 0;
        await createdChannel.drain();

        expect(createdChannel.sent).toEqual([
            JSON.stringify({ seq: 2 })
        ]);
        expect(dataChannel.readHealth()).toMatchObject({
            queuedItemCount: 0,
            counters: {
                queued: 2,
                droppedOldest: 1,
                flushed: 1,
                sent: 1
            }
        });
    });
});

interface NativeDataChannelFixture {
    readonly peerConnection: QRtcPeerConnection;
    readonly native: SimulatedNativeRtcPeerConnection;
}

function createNativeDataChannelFixture(): NativeDataChannelFixture {
    const peerConnection = new QRtcPeerConnection({ send: async () => {} }, {
        sessionId: 'self',
        token: 'fixture-token',
        peerSessionId: 'peer-1',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
        isPolite: false
    });
    peerConnection.connect();
    peers.push(peerConnection);
    const native = peerConnection.status.pc;
    if (!(native instanceof SimulatedNativeRtcPeerConnection)) {
        throw new Error('Expected the installed native RTC fixture');
    }
    return { peerConnection, native };
}
