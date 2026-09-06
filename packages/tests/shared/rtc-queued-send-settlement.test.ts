import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QRtcDataChannel, type RtcDataChannelFlowControlPolicy } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import { installNativeRtcRuntime, type NativeRtcRuntime } from './native-rtc-connection-fixture.ts';

let runtime: NativeRtcRuntime;
const channels: QRtcDataChannel[] = [];
const peers: QRtcPeerConnection[] = [];

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    runtime = installNativeRtcRuntime();
});

afterEach(async () => {
    for (const channel of channels.splice(0)) {
        channel.reset();
    }
    for (const peer of peers.splice(0)) {
        peer.reset();
    }
    await Promise.resolve();
    runtime.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('RTC queued send settlement', () => {
    it.each(['closed', 'backpressure', 'full'] as const)('reports immediate %s rejection without retaining the send', async (rejection) => {
        const { channel, native } = createChannel({ overflow: rejection === 'backpressure' ? 'drop-new' : 'queue', maxQueueItems: 1 });
        if (rejection !== 'closed') {
            await native.open();
            native.bufferedAmount = 10;
        }
        if (rejection === 'full') {
            channel.sendRaw('retained');
        }
        const outcomes: string[] = [];

        const result = channel.sendRaw('rejected', {
            onSettled: (settled) => {
                outcomes.push(settled.status);
            }
        });
        await Promise.resolve();

        const expected = rejection === 'closed' ? 'closed' : 'dropped';
        expect(result.status).toBe(expected);
        expect(outcomes).toEqual([expected]);
        expect(native.sent).toEqual([]);
        expect(channel.readHealth().queuedItemCount).toBe(rejection === 'full' ? 1 : 0);
    });

    it('reports an immediate native failure while preserving the thrown send error', async () => {
        const { channel, native } = createChannel();
        await native.open();
        const outcomes: string[] = [];
        vi.spyOn(native, 'send').mockImplementationOnce(() => {
            throw new Error('Native payload rejected');
        });

        expect(() =>
            channel.sendRaw('bad', {
                onSettled: (settled) => {
                    outcomes.push(settled.status);
                }
            })
        )
            .toThrow('Native payload rejected');
        await Promise.resolve();

        expect(outcomes).toEqual(['failed']);
        expect(native.sent).toEqual([]);
        expect(channel.sendRaw('good').status).toBe('sent');
        expect(native.sent).toEqual(['good']);
    });

    it('reports transport submission after returning the immediate result', async () => {
        const { channel, native } = createChannel();
        await native.open();
        const settlements: QRtcDataChannel.SendSettlement[] = [];

        const result = channel.sendRaw('hello', {
            onSettled: (settled) => {
                settlements.push(settled);
            }
        });

        expect(result.status).toBe('sent');
        expect(settlements).toEqual([]);
        await Promise.resolve();
        expect(settlements).toEqual([expect.objectContaining({ status: 'sent' })]);
        expect(native.sent).toEqual(['hello']);
    });

    it('keeps a queued send unconfirmed until flush and settles it only once', async () => {
        const { channel, native } = createChannel();
        await native.open();
        native.bufferedAmount = 10;
        const settlements: QRtcDataChannel.SendSettlement[] = [];

        const result = channel.sendRaw('queued', {
            onSettled: (settled) => {
                settlements.push(settled);
            }
        });
        await Promise.resolve();
        expect(result.status).toBe('queued');
        expect(settlements).toEqual([]);

        native.bufferedAmount = 0;
        await native.drain();
        await native.close();
        expect(settlements).toEqual([expect.objectContaining({ status: 'sent' })]);
        expect(native.sent).toEqual(['queued']);
        expect(channel.readHealth().queuedItemCount).toBe(0);
    });

    it.each(['replace-by-key', 'drop-old'] as const)('settles the displaced send under %s without settling its replacement early', async (overflow) => {
        const { channel, native } = createChannel({ overflow, maxQueueItems: 1 });
        await native.open();
        native.bufferedAmount = 10;
        const outcomes: string[] = [];
        channel.sendRaw('old', {
            key: 'position',
            onSettled: (settled) => {
                outcomes.push(`old:${settled.status}`);
            }
        });
        channel.sendRaw('new', {
            key: 'position',
            onSettled: (settled) => {
                outcomes.push(`new:${settled.status}`);
            }
        });

        await Promise.resolve();
        const displacedStatus = overflow === 'replace-by-key' ? 'superseded' : 'dropped';
        expect(outcomes).toEqual([`old:${displacedStatus}`]);
        native.bufferedAmount = 0;
        await native.drain();
        expect(outcomes).toEqual([`old:${displacedStatus}`, 'new:sent']);
        expect(native.sent).toEqual(['new']);
    });

    it('expires queued work even when the native channel never becomes writable', async () => {
        const { channel, native } = createChannel();
        await native.open();
        native.bufferedAmount = 10;
        const outcomes: string[] = [];
        channel.sendRaw('short-lived', {
            maxAgeMs: 10,
            onSettled: (settled) => {
                outcomes.push(settled.status);
            }
        });

        await vi.advanceTimersByTimeAsync(10);
        expect(outcomes).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(outcomes).toEqual(['expired']);
        expect(channel.readHealth().queuedItemCount).toBe(0);
        native.bufferedAmount = 0;
        await native.drain();
        expect(native.sent).toEqual([]);
        expect(outcomes).toEqual(['expired']);
    });

    it.each(['close', 'fail', 'reset'] as const)('settles all retained work once after %s', async (ending) => {
        const { channel, native } = createChannel();
        await native.open();
        native.bufferedAmount = 10;
        const outcomes: string[] = [];
        for (const payload of ['a', 'b']) {
            channel.sendRaw(payload, {
                maxAgeMs: 100,
                onSettled: (settled) => {
                    outcomes.push(`${payload}:${settled.status}`);
                }
            });
        }

        if (ending === 'reset') {
            channel.reset();
        }
        else {
            await native[ending]();
        }
        await vi.advanceTimersByTimeAsync(200);
        const status = ending === 'fail' ? 'failed' : 'closed';
        expect(outcomes).toEqual([`a:${status}`, `b:${status}`]);
        expect(channel.readHealth().queuedItemCount).toBe(0);
        expect(native.sent).toEqual([]);
    });

    it('reports a queued native-send failure while allowing the remaining queue to make progress', async () => {
        const { channel, native } = createChannel();
        await native.open();
        native.bufferedAmount = 10;
        const outcomes: string[] = [];
        channel.sendRaw('bad', {
            onSettled: (settled) => {
                outcomes.push(`bad:${settled.status}`);
            }
        });
        channel.sendRaw('good', {
            onSettled: (settled) => {
                outcomes.push(`good:${settled.status}`);
            }
        });
        vi.spyOn(native, 'send').mockImplementationOnce(() => {
            throw new Error('Native payload rejected');
        });

        native.bufferedAmount = 0;
        await native.drain();

        expect(outcomes).toEqual(['bad:failed', 'good:sent']);
        expect(native.sent).toEqual(['good']);
        expect(channel.readHealth().queuedItemCount).toBe(0);
    });

    it('isolates observer failure and runs reentrant sends after the retained queue', async () => {
        const { channel, native } = createChannel();
        await native.open();
        native.bufferedAmount = 10;
        vi.spyOn(console, 'error').mockImplementation(() => {});
        channel.sendRaw('first', {
            onSettled: async () => {
                channel.sendRaw('third');
                throw new Error('Application observer failed');
            }
        });
        channel.sendRaw('second');

        native.bufferedAmount = 0;
        await native.drain();
        await vi.advanceTimersByTimeAsync(0);

        expect(native.sent).toEqual(['first', 'second', 'third']);
        expect(channel.readHealth().queuedItemCount).toBe(0);
    });

    it('ignores a stale low-water event after a new channel generation takes ownership', async () => {
        const { channel, native } = createChannel();
        await native.open();
        const previousLowWaterHandler = native.onbufferedamountlow;
        channel.reset();
        channel.connect(true);
        const replacement = runtime.createdConnections[0].channels[1];
        await replacement.open();
        replacement.bufferedAmount = 10;
        const outcomes: string[] = [];
        channel.sendRaw('new-generation', {
            onSettled: (settled) => {
                outcomes.push(settled.status);
            }
        });

        replacement.bufferedAmount = 0;
        await previousLowWaterHandler?.call(native, new Event('bufferedamountlow'));
        expect(replacement.sent).toEqual([]);
        expect(outcomes).toEqual([]);
        await replacement.drain();
        expect(replacement.sent).toEqual(['new-generation']);
        expect(outcomes).toEqual(['sent']);
    });

    it('settles retained work before replacing a native channel whose close event is delayed', async () => {
        const { channel, native } = createChannel();
        await native.open();
        native.bufferedAmount = 10;
        const outcomes: string[] = [];
        channel.sendRaw('old-generation', {
            onSettled: (settled) => {
                outcomes.push(settled.status);
            }
        });
        vi.spyOn(native, 'close').mockImplementation(async () => {
            native.readyState = 'closing';
        });

        const replacement = await runtime.createdConnections[0].receiveDataChannel('alm');
        await replacement.open();
        await replacement.drain();

        expect(outcomes).toEqual(['closed']);
        expect(replacement.sent).toEqual([]);
        expect(channel.readHealth().queuedItemCount).toBe(0);
    });
});

function createChannel(flowControl: RtcDataChannelFlowControlPolicy = {}) {
    const peer = new QRtcPeerConnection({ send: async () => {} }, {
        sessionId: 'self',
        peerSessionId: 'peer',
        token: 'fixture-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
        isPolite: false
    });
    peer.connect();
    peers.push(peer);
    const channel = new QRtcDataChannel(peer, {
        peerId: 'peer',
        dataChannelName: 'alm',
        flowControl: { highWatermarkBytes: 10, lowWatermarkBytes: 1, overflow: 'queue', maxQueueItems: 4, ...flowControl }
    });
    channels.push(channel);
    channel.connect(true);
    const native = runtime.createdConnections.at(-1)!.channels[0];
    return { channel, native };
}
