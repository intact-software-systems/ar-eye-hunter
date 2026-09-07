import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { isPeerSetupStarted, QRtcPeerDto, WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import {
    QRtcSignalingChannel,
    QRtcSignalingMessage,
    QRtcSignalingMsgType,
    QRtcSignalingType
} from '@shared/webrtc/QRtcSignalingContracts.ts';

import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    NativeRtcConnectionFixture,
    NativeRtcRuntime
} from './native-rtc-connection-fixture.ts';

let runtime: NativeRtcRuntime;
const fixtures: NativeRtcConnectionFixture[] = [];
beforeEach(() => {
    runtime = installNativeRtcRuntime();
});
afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
        fixture.dispose();
    }
    runtime.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function createInput(): WebRtcConnectionService.InputDto {
    return {
        sessionId: 'a-self',
        token: 'private-transport-token',
        dataChannelName: 'room',
        rtcSignalingTopicId: 'rtc',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 1_000 }
    };
}

function createFixture(input = createInput()): NativeRtcConnectionFixture {
    const fixture = createNativeRtcConnectionFixture(input, runtime);
    fixtures.push(fixture);
    return fixture;
}

function offer(peerId = 'z-peer'): QRtcSignalingMessage {
    return {
        channel: QRtcSignalingChannel.RtcSignal,
        type: QRtcSignalingMsgType.Signal,
        fromId: peerId,
        toId: 'a-self',
        sessionId: peerId,
        token: 'private-peer-token',
        signalType: QRtcSignalingType.Offer,
        payload: { description: { type: 'offer', sdp: 'private-offer-sdp' }, candidate: null }
    };
}

function budgetInput(): WebRtcConnectionService.InputDto {
    return {
        ...createInput(),
        peerEstablishmentTimeout: { enabled: true, timeoutMs: 50 },
        peerConnectionAttemptBudget: { enabled: true, maxAttempts: 2, maxTotalDurationMs: 100, cooldownMs: 30 }
    };
}

describe('WebRtcConnectionService signaling and creation', () => {
    it('rejects a forged nested peer identity before peer allocation', async () => {
        const fixture = createFixture(budgetInput());
        await fixture.service.connectSignaler();
        await expect(fixture.receiveResource(JSON.stringify(offer('victim')), 'attacker')).rejects.toThrow(
            'RTC signaling identity does not match its AL envelope'
        );
        expect(runtime.createdConnections).toHaveLength(0);
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(0);
    });
    it('decodes a real offer and ICE into the native peer without logging credentials or payloads', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const fixture = createFixture();
        await fixture.service.connectSignaler();
        await fixture.receive(offer());
        await fixture.receive({
            ...offer(),
            signalType: QRtcSignalingType.IceCandidate,
            payload: { description: null, candidate: { candidate: 'private-candidate', sdpMid: '0', sdpMLineIndex: 0 } }
        });
        expect(fixture.nativePeer('z-peer').receivedDescriptions).toEqual([{ type: 'offer', sdp: 'private-offer-sdp' }]);
        expect(fixture.nativePeer('z-peer').receivedCandidates).toEqual([{ candidate: 'private-candidate', sdpMid: '0', sdpMLineIndex: 0 }]);
        expect(fixture.sentSignals).toMatchObject([{ signalType: 'Answer', toId: 'z-peer' }]);
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-(transport-token|peer-token|offer-sdp|candidate)/);
    });

    it.each([
        { channel: 'wrong' },
        { type: 'wrong' },
        { signalType: 'unknown' },
        { fromId: '' },
        { token: 1 },
        { payload: { description: { type: 'offer', sdp: 42 }, candidate: null } },
        { payload: { description: { type: 'answer', sdp: 'sdp' }, candidate: null } },
        { payload: { description: { type: 'offer', sdp: 'sdp' }, candidate: { candidate: 'extra' } } },
        { signalType: 'IceCandidate', payload: { description: null, candidate: { candidate: 12 } } }
    ])('rejects malformed signaling before native creation: %j', async (invalid) => {
        const fixture = createFixture(budgetInput());
        await fixture.service.connectSignaler();
        await expect(fixture.receiveResource(JSON.stringify({ ...offer(), ...invalid }))).rejects.toThrow();
        expect(runtime.createdConnections).toHaveLength(0);
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(0);
    });

    it('keeps malformed JSON diagnostics free of serialized secret fragments', async () => {
        const fixture = createFixture();
        await fixture.service.connectSignaler();
        const received = fixture.receiveResource('{"private-peer-token":"private-offer-sdp",BROKEN}');
        await expect(received).rejects.toThrow('Invalid RTC signaling message');
        await expect(received).rejects.not.toHaveProperty('cause');
        expect(runtime.createdConnections).toHaveLength(0);
    });

    it('validates direct accepted-peer signaling before allocating native resources', async () => {
        const fixture = createFixture(budgetInput());
        const result = await fixture.service.acceptPeerIfAbsent('z-peer', { ...offer(), payload: { description: 17, candidate: null } });
        expect(result.left?.kind).toBe('signal-handle-failed');
        expect(runtime.createdConnections).toHaveLength(0);
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(0);
    });

    it('rejects another recipient and ignores self signals and missing-peer answers', async () => {
        const fixture = createFixture();
        await fixture.service.connectSignaler();
        await expect(fixture.receive({ ...offer(), toId: 'other' })).rejects.toThrow('RTC signaling identity does not match its AL envelope');
        await fixture.receive(offer('a-self'));
        await fixture.receive({ ...offer(), signalType: 'Answer', payload: { description: { type: 'answer', sdp: 'answer' }, candidate: null } });
        expect(runtime.createdConnections).toHaveLength(0);
    });

    it('queues legitimate early ICE until an offer supplies the remote description', async () => {
        const fixture = createFixture();
        await fixture.service.connectSignaler();
        await fixture.receive({ ...offer(), signalType: 'IceCandidate', payload: { description: null, candidate: { candidate: 'ice' } } });
        expect(fixture.nativePeer('z-peer').receivedCandidates).toEqual([]);
        await fixture.receive(offer());
        expect(fixture.nativePeer('z-peer').receivedCandidates).toEqual([{ candidate: 'ice' }]);
        expect(runtime.createdConnections).toHaveLength(1);
    });

    it.each([false, 'deny', { decision: 'deny', reason: 'not-desired' }] satisfies WebRtcConnectionService.PeerCreationDecision[])(
        'denies inbound creation without attempts for policy %j',
        async (decision) => {
            const fixture = createFixture(budgetInput());
            fixture.service.setInboundPeerCreationPolicy(() => decision);
            await fixture.service.connectSignaler();
            await fixture.receive(offer());
            expect(runtime.createdConnections).toHaveLength(0);
            expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(0);
        }
    );

    it('applies outbound denial to every public creation entry and inbound offers', async () => {
        const fixture = createFixture(budgetInput());
        fixture.service.setOutboundDialPolicy(() => ({ decision: 'deny', reason: 'not-desired' }));
        expect(fixture.service.ensurePeerConnectionStarted('z-peer').left).toMatchObject({ kind: 'dial-denied', reason: 'not-desired' });
        expect(await fixture.service.ensurePeerLaneOpen('z-peer')).toMatchObject({ status: 'connect-failed' });
        expect((await fixture.service.acceptPeerIfAbsent('z-peer', offer())).left).toMatchObject({ kind: 'dial-denied' });
        await fixture.service.connectSignaler();
        await fixture.receive(offer());
        expect(runtime.createdConnections).toHaveLength(0);
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(0);
    });

    it('fails closed when an admission policy throws', async () => {
        const fixture = createFixture(budgetInput());
        fixture.service.setOutboundDialPolicy(() => {
            throw 'policy failure';
        });
        expect(fixture.service.ensurePeerConnectionStarted('z-peer').left).toMatchObject({ kind: 'dial-denied', reason: 'policy-error' });
        fixture.service.setOutboundDialPolicy();
        fixture.service.setInboundPeerCreationPolicy(() => {
            throw 'policy failure';
        });
        await fixture.service.connectSignaler();
        await fixture.receive(offer());
        expect(runtime.createdConnections).toHaveLength(0);
    });

    it('retains an existing peer and handles its real signaling after policies deny new peers', async () => {
        const fixture = createFixture();
        const first = fixture.service.ensurePeerConnectionStarted('z-peer').right?.peer;
        fixture.nativePeer('z-peer').setConnected();
        fixture.service.setOutboundDialPolicy(() => false).setInboundPeerCreationPolicy(() => false);
        expect(fixture.service.ensurePeerConnectionStarted('z-peer').right?.peer).toBe(first);
        await fixture.service.connectSignaler();
        await fixture.receive(offer());
        expect(fixture.nativePeer('z-peer').receivedDescriptions).toHaveLength(1);
        await fixture.receive(offer('new-peer'));
        expect(runtime.createdConnections).toHaveLength(1);
    });

    it.each(['failed', 'reset'] as const)('denies replacement of a %s native peer without consuming another attempt', async (state) => {
        const fixture = createFixture(budgetInput());
        fixture.service.ensurePeerConnectionStarted('z-peer', true);
        makeNativePeerUnusable(fixture, state);
        fixture.service.setOutboundDialPolicy(() => ({ decision: 'deny', reason: 'stage-layout-mismatch' }));

        expect(fixture.service.ensurePeerConnectionStarted('z-peer').left).toMatchObject({ kind: 'dial-denied', reason: 'stage-layout-mismatch' });
        expect(await fixture.service.ensurePeerLaneOpen('z-peer')).toMatchObject({ status: 'connect-failed' });
        expect((await fixture.service.acceptPeerIfAbsent('z-peer', offer())).left).toMatchObject({ kind: 'dial-denied' });

        expect(runtime.createdConnections).toHaveLength(1);
        expect(fixture.service.knownPeerIds()).toEqual([]);
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(1);
        expect(fixture.service.peerConnectionAttemptDiagnostics('z-peer')?.attempts).toBe(1);
    });

    it.each(
        [
            ['failed', 'inbound'],
            ['reset', 'inbound'],
            ['failed', 'outbound'],
            ['reset', 'outbound']
        ] as const
    )('applies current %s-native %s admission to incoming offers', async (state, policy) => {
        const fixture = createFixture(budgetInput());
        fixture.service.ensurePeerConnectionStarted('z-peer', true);
        const native = fixture.nativePeer('z-peer');
        makeNativePeerUnusable(fixture, state);
        if (policy === 'inbound') {
            fixture.service.setInboundPeerCreationPolicy(() => false);
        }
        else {
            fixture.service.setOutboundDialPolicy(() => false);
        }
        await fixture.service.connectSignaler();

        await fixture.receive(offer());

        expect(runtime.createdConnections).toHaveLength(1);
        expect(native.receivedDescriptions).toEqual([]);
        expect(fixture.service.knownPeerIds()).toEqual([]);
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(1);
    });

    it.each(['failed', 'reset'] as const)('counts replacement of an admitted %s native peer as another establishment attempt', (state) => {
        const fixture = createFixture(budgetInput());
        const original = fixture.service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        makeNativePeerUnusable(fixture, state);

        const replacement = fixture.service.ensurePeerConnectionStarted('z-peer', true).right;

        expect(replacement?.peer.peerId).toBe('z-peer');
        expect(replacement?.outcome).toBe('setup-started');
        expect(replacement?.peer).not.toBe(original);
        expect(runtime.createdConnections).toHaveLength(2);
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(2);
        expect(fixture.service.peerConnectionAttemptDiagnostics('z-peer')?.attempts).toBe(2);
        expect(runtime.createdConnections[0].connectionState).toBe('closed');
        makeNativePeerUnusable(fixture, state);
        expect(fixture.service.ensurePeerConnectionStarted('z-peer').left).toMatchObject({ kind: 'connect-exhausted' });
        expect(runtime.createdConnections).toHaveLength(2);
    });

    it('replaces an admitted failed inbound peer within the same connection limit', async () => {
        const fixture = createFixture({ ...budgetInput(), maxPeerConnections: 1 });
        fixture.service.ensurePeerConnectionStarted('z-peer', true);
        makeNativePeerUnusable(fixture, 'failed');
        await fixture.service.connectSignaler();

        await fixture.receive(offer());

        expect(runtime.createdConnections).toHaveLength(2);
        expect(fixture.nativePeer('z-peer').receivedDescriptions).toEqual([{ type: 'offer', sdp: 'private-offer-sdp' }]);
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(2);
    });

    it.each(['new', 'connecting'] as const)('reuses a %s native peer after new creation is denied', async (state) => {
        const fixture = createFixture(budgetInput());
        const original = fixture.service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        const native = fixture.nativePeer('z-peer');
        native.connectionState = state;
        fixture.service.setOutboundDialPolicy(() => false).setInboundPeerCreationPolicy(() => false);
        await fixture.service.connectSignaler();

        expect(fixture.service.ensurePeerConnectionStarted('z-peer').right?.peer).toBe(original);
        await fixture.receive(offer());

        expect(runtime.createdConnections).toHaveLength(1);
        expect(native.receivedDescriptions).toHaveLength(1);
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(1);
    });

    it('caps new inbound peers without blocking established-peer signaling', async () => {
        const fixture = createFixture({ ...createInput(), maxPeerConnections: 1 });
        await fixture.service.connectSignaler();
        await fixture.receive(offer());
        await fixture.receive(offer('another-peer'));
        await fixture.receive(offer());
        expect(runtime.createdConnections).toHaveLength(1);
        expect(fixture.nativePeer('z-peer').receivedDescriptions).toHaveLength(2);
    });
});

describe('WebRtcConnectionService peer and lane lifecycle', () => {
    it.each([false, true])('reuses the native peer when creation observers ensure it again (deny later dials: %s)', async (denyLaterDials) => {
        const fixture = createFixture(budgetInput());
        const created: QRtcPeerDto[] = [];
        const reentered: (QRtcPeerDto | undefined)[] = [];
        const allocationsBeforeCallbacks: number[] = [];
        const opened = vi.fn(async () => {});
        fixture.service.onRtcPeerLifecycleDo('reentrant', {
            onCreated: (peer) => {
                created.push(peer);
                allocationsBeforeCallbacks.push(runtime.createdConnections.length);
                peer.channel.onRtcCallbacksDo('creation-observer', { onOpen: opened });
                if (created.length === 1) {
                    if (denyLaterDials) {
                        fixture.service.setOutboundDialPolicy(() => false);
                    }
                    reentered.push(fixture.service.ensurePeerConnectionStarted(peer.peerId, true).right?.peer);
                }
            },
            onDeleted: () => {}
        });

        const result = fixture.service.ensurePeerConnectionStarted('z-peer', true);

        expect(allocationsBeforeCallbacks).toEqual([1]);
        expect(created).toEqual([result.right?.peer]);
        expect(reentered).toEqual([result.right?.peer]);
        expect(fixture.service.readPeer('z-peer')).toBe(result.right?.peer);
        expect(runtime.createdConnections).toHaveLength(1);
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(1);
        const native = fixture.nativePeer('z-peer');
        expect(native.channels).toHaveLength(1);
        await native.channels[0].open();
        expect(opened).toHaveBeenCalledOnce();
    });

    it('does not allocate a replacement after a creation observer resets the peer and closes admission', () => {
        const fixture = createFixture(budgetInput());
        const denials: string[] = [];
        fixture.service.onRtcPeerLifecycleDo('reset', {
            onCreated: (peer) => {
                peer.connection.reset();
                fixture.service.setOutboundDialPolicy(() => false);
                const result = fixture.service.ensurePeerConnectionStarted(peer.peerId, true);
                if (result.left) {
                    denials.push(result.left.kind);
                }
            },
            onDeleted: () => {}
        });

        const result = fixture.service.ensurePeerConnectionStarted('z-peer', true);

        expect(result.left?.kind).toBe('connect-failed');
        expect(denials).toEqual(['dial-denied']);
        expect(fixture.service.readPeer('z-peer')).toBeUndefined();
        expect(runtime.createdConnections).toHaveLength(1);
        expect(runtime.createdConnections[0].connectionState).toBe('closed');
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(1);
    });

    it('creates a peer once with default politeness and tears down actual native resources', async () => {
        const fixture = createFixture();
        const lifecycle: string[] = [];
        fixture.service.onRtcPeerLifecycleDo('test', {
            onCreated: (peer) => {
                lifecycle.push(`created:${peer.peerId}`);
            },
            onDeleted: (peer) => {
                lifecycle.push(`deleted:${peer.peerId}`);
            }
        });
        const first = fixture.service.ensurePeerConnectionStarted('z-peer');
        expect(Object.hasOwn(first, 'then')).toBe(false);
        expect(fixture.service.ensurePeerConnectionStarted('z-peer').right?.peer).toBe(first.right?.peer);
        const native = fixture.nativePeer('z-peer');
        expect(native.channels).toHaveLength(0);
        const channel = await native.receiveDataChannel('room');
        channel.open();
        native.close();
        expect(fixture.service.knownPeerIds()).toEqual([]);
        expect(channel.readyState).toBe('closed');
        expect(first.right?.peer.connection.status.pc).toBeUndefined();
        expect(first.right?.peer.media.status.state).toBe('Idle');
        expect(lifecycle).toEqual(['created:z-peer', 'deleted:z-peer']);
        expect(fixture.service.removeRtcPeerLifecycleById('test')).toBe(true);
        expect(fixture.service.disconnectPeer('missing')).toBe(false);
    });

    it('completes native teardown and notifies later observers when a deletion observer throws', () => {
        const fixture = createFixture();
        fixture.service.ensurePeerConnectionStarted('z-peer', true);
        const native = fixture.nativePeer('z-peer');
        const deleted: string[] = [];
        fixture.service.onRtcPeerLifecycleDo('broken', {
            onCreated: () => {},
            onDeleted: () => {
                throw new Error('observer failed');
            }
        });
        fixture.service.onRtcPeerLifecycleDo('healthy', {
            onCreated: () => {},
            onDeleted: (peer) => {
                deleted.push(peer.peerId);
            }
        });
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(fixture.service.removePeerIfPresent('z-peer')).toBe(true);

        expect(fixture.service.knownPeerIds()).toEqual([]);
        expect(native.connectionState).toBe('closed');
        expect(deleted).toEqual(['z-peer']);
        expect(logged).toHaveBeenCalledWith('Error calling onRtcPeerLifecycleCallbacks.onDeleted', expect.any(Error));
    });

    it('does not lose a new peer created by a deletion observer', () => {
        const fixture = createFixture();
        const original = fixture.service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        const native = fixture.nativePeer('z-peer');
        fixture.service.onRtcPeerLifecycleDo('replacement', {
            onCreated: () => {},
            onDeleted: () => {
                fixture.service.removeRtcPeerLifecycleById('replacement');
                fixture.service.ensurePeerConnectionStarted('z-peer', true);
            }
        });

        fixture.service.removePeerIfPresent('z-peer');

        expect(native.connectionState).toBe('closed');
        expect(fixture.service.readPeer('z-peer')?.peerId).toBe('z-peer');
        expect(fixture.service.readPeer('z-peer')).not.toBe(original);
        expect(runtime.createdConnections).toHaveLength(2);
    });

    it('reuses an admitted replacement created while a failed peer is being removed', () => {
        const fixture = createFixture(budgetInput());
        fixture.service.ensurePeerConnectionStarted('z-peer', true);
        makeNativePeerUnusable(fixture, 'failed');
        fixture.service.onRtcPeerLifecycleDo('replacement', {
            onCreated: () => {},
            onDeleted: () => {
                fixture.service.removeRtcPeerLifecycleById('replacement');
                fixture.service.ensurePeerConnectionStarted('z-peer', true);
            }
        });

        const replacement = fixture.service.ensurePeerConnectionStarted('z-peer', true);

        expect(replacement.right?.peer).toBe(fixture.service.readPeer('z-peer'));
        expect(runtime.createdConnections).toHaveLength(2);
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(2);
    });

    it('uses session identity for self rejection and independent same-principal peers', async () => {
        const fixture = createFixture({ ...createInput(), sessionId: 'alice-session-a' });
        expect(fixture.service.ensurePeerConnectionStarted('alice-session-a').left).toMatchObject({ kind: 'self' });
        expect(await fixture.service.ensurePeerLaneOpen('alice-session-a')).toMatchObject({ status: 'self' });
        fixture.service.ensurePeerConnectionStarted('alice-session-b');
        fixture.service.ensurePeerConnectionStarted('alice-session-c');
        const removed = fixture.nativePeer('alice-session-b');
        fixture.service.disconnectPeer('alice-session-b');
        expect(removed.connectionState).toBe('closed');
        expect(fixture.service.knownPeerIds()).toEqual(['alice-session-c']);
        expect(fixture.nativePeer('alice-session-c').connectionState).toBe('new');
    });

    it('reconnects only a stale channel on the existing native peer', async () => {
        const fixture = createFixture();
        fixture.service.ensurePeerConnectionStarted('z-peer', true);
        const native = fixture.nativePeer('z-peer');
        native.setConnected();
        const channel = native.channels[0];
        channel.open();
        channel.close();
        fixture.service.setOutboundDialPolicy(() => false).setInboundPeerCreationPolicy(() => false);
        expect(fixture.service.peerIdsWithNoReconnectableLanes()).toEqual([]);
        fixture.service.ensurePeerConnectionStarted('z-peer', true);
        expect(runtime.createdConnections).toHaveLength(1);
        expect(native.channels).toHaveLength(2);
        expect(fixture.service.peerIdsWithNoReconnectableLanes()).toEqual(['z-peer']);
    });

    it('separates known, active, reconciled and ready lanes with reliable and realtime configuration', () => {
        const fixture = createFixture({
            ...createInput(),
            dataChannelLanes: [{
                id: 'realtime',
                label: 'rtc-realtime',
                init: { ordered: false, maxRetransmits: 0 },
                binaryType: 'arraybuffer',
                flowControl: { highWatermarkBytes: 1024, lowWatermarkBytes: 256, overflow: 'replace-by-key', maxQueueItems: 8 }
            }]
        });
        fixture.service.ensurePeerConnectionStarted('z-peer', true);
        const native = fixture.nativePeer('z-peer');
        expect(native.channels.map((channel) => channel.label)).toEqual(['room', 'rtc-realtime']);
        expect(native.channels[1]).toMatchObject({ ordered: false, maxRetransmits: 0, binaryType: 'arraybuffer' });
        expect(fixture.service.knownPeerIds()).toEqual(['z-peer']);
        expect(fixture.service.activePeerIds()).toEqual(['z-peer']);
        expect(fixture.service.readyPeerIdsForLane()).toEqual([]);
        native.channels[0].open();
        native.channels[1].close();
        expect(fixture.service.readyPeerIdsForLane()).toEqual(['z-peer']);
        expect(fixture.service.readyPeerIdsForLane('realtime')).toEqual([]);
        expect(fixture.service.peerIdsWithNoReconnectableLanes()).toEqual([]);
        expect(fixture.service.readAllPeerHealth()).toMatchObject([{
            peerId: 'z-peer',
            channels: [
                { laneId: 'reliable', channel: { readyState: 'open' } },
                { laneId: 'realtime', channel: { state: 'Closed' } }
            ]
        }]);
    });

    it('waits for the requested native lane to open', async () => {
        const fixture = createFixture();
        const pending = fixture.service.ensurePeerLaneOpen('z-peer', 'reliable', { isInitiator: true, timeoutMs: 100 });
        await Promise.resolve();
        fixture.nativePeer('z-peer').channels[0].open();
        expect(await pending).toMatchObject({ status: 'open', peerId: 'z-peer', laneId: 'reliable', channel: fixture.service.readPeerChannel('z-peer') });
    });

    it('reports missing lanes and bounded timeout without removing the peer by default', async () => {
        vi.useFakeTimers();
        const fixture = createFixture();
        expect(await fixture.service.ensurePeerLaneOpen('z-peer', 'missing')).toMatchObject({ status: 'no-lane' });
        const pending = fixture.service.ensurePeerLaneOpen('z-peer', 'reliable', { timeoutMs: 25 });
        await vi.advanceTimersByTimeAsync(25);
        expect(await pending).toMatchObject({ status: 'timeout' });
        expect(fixture.service.knownPeerIds()).toEqual(['z-peer']);
    });

    it('removes native resources when explicit lane timeout cleanup is requested', async () => {
        vi.useFakeTimers();
        const fixture = createFixture();
        const pending = fixture.service.ensurePeerLaneOpen('z-peer', 'reliable', { timeoutMs: 25, cleanupOnFailure: true });
        await Promise.resolve();
        const native = fixture.nativePeer('z-peer');
        await vi.advanceTimersByTimeAsync(25);
        expect(await pending).toMatchObject({ status: 'timeout' });
        expect(native.connectionState).toBe('closed');
        expect(fixture.service.knownPeerIds()).toEqual([]);
    });

    it('cancels an actual lane wait and prevents creation when already aborted', async () => {
        const fixture = createFixture();
        const controller = new AbortController();
        const pending = fixture.service.ensurePeerLaneOpen('z-peer', 'reliable', { signal: controller.signal, timeoutMs: 100 });
        await Promise.resolve();
        controller.abort(new Error('stop waiting'));
        expect(await pending).toMatchObject({ status: 'aborted' });
        expect(await fixture.service.ensurePeerLaneOpen('other-peer', 'reliable', { signal: controller.signal })).toMatchObject({ status: 'aborted' });
        expect(runtime.createdConnections).toHaveLength(1);
    });
});

describe('WebRtcConnectionService establishment attempts', () => {
    it('expires stalled peers, exhausts attempts once, and permits retry only after cooldown', async () => {
        vi.useFakeTimers();
        const fixture = createFixture(budgetInput());
        const events: string[] = [];
        fixture.service.onRtcPeerLifecycleDo('test', {
            onCreated: () => {},
            onDeleted: () => {},
            onConnectTimeout: (peer) => {
                events.push(`timeout:${peer.peerId}`);
            },
            onConnectExhausted: (event) => {
                events.push(`exhausted:${event.attempts}`);
            }
        });
        fixture.service.ensurePeerConnectionStarted('z-peer');
        const first = fixture.nativePeer('z-peer');
        await vi.advanceTimersByTimeAsync(50);
        expect(first.connectionState).toBe('closed');
        expect(fixture.service.inFlightPeerIds()).toEqual([]);
        fixture.service.ensurePeerConnectionStarted('z-peer');
        await vi.advanceTimersByTimeAsync(50);
        expect(fixture.service.ensurePeerConnectionStarted('z-peer').left).toMatchObject({ kind: 'connect-exhausted', event: { attempts: 2 } });
        await vi.advanceTimersByTimeAsync(29);
        expect(fixture.service.ensurePeerConnectionStarted('z-peer').left?.kind).toBe('connect-exhausted');
        expect(events).toEqual(['timeout:z-peer', 'timeout:z-peer', 'exhausted:2']);
        await vi.advanceTimersByTimeAsync(1);
        expect(fixture.service.ensurePeerConnectionStarted('z-peer').right?.peer.peerId).toBe('z-peer');
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics()).toEqual({
            consumedCount: 3,
            exhaustedCount: 1,
            cooldownExpiredClearCount: 1,
            resetOnSuccessCount: 0,
            resetOnRemovalCount: 0
        });
        fixture.service.disconnectPeer('z-peer');
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().resetOnRemovalCount).toBe(1);
    });

    it('clears both establishment watchdog and attempt history when the actual lane opens', async () => {
        vi.useFakeTimers();
        const fixture = createFixture(budgetInput());
        fixture.service.ensurePeerConnectionStarted('z-peer', true);
        expect(fixture.service.peerConnectionAttemptDiagnostics('z-peer')).toMatchObject({ attempts: 1 });
        fixture.nativePeer('z-peer').channels[0].open();
        expect(fixture.service.peerConnectionAttemptDiagnostics('z-peer')).toBeUndefined();
        await vi.advanceTimersByTimeAsync(50);
        expect(fixture.service.knownPeerIds()).toEqual(['z-peer']);
        expect(fixture.service.readPeerConnectionAttemptBudgetDiagnostics().resetOnSuccessCount).toBe(1);
    });
});

describe('WebRtcConnectionService setup phases', () => {
    it('reports whether an ensure started a setup, found one in flight, or found the peer established', async () => {
        const fixture = createFixture();
        const started = fixture.service.ensurePeerConnectionStarted('z-peer', true);
        expect(started.right).toMatchObject({ outcome: 'setup-started', peer: { peerId: 'z-peer' } });
        expect(fixture.service.ensurePeerConnectionStarted('z-peer').right?.outcome).toBe('setup-in-flight');
        expect(fixture.service.inFlightPeerIds()).toEqual(['z-peer']);

        await fixture.nativePeer('z-peer').channels[0].open();

        expect(fixture.service.ensurePeerConnectionStarted('z-peer').right?.outcome).toBe('setup-established');
        expect(fixture.service.inFlightPeerIds()).toEqual([]);
    });

    it('stops reporting a setup in flight once its native connection has failed', () => {
        const fixture = createFixture();
        fixture.service.ensurePeerConnectionStarted('z-peer', true);

        makeNativePeerUnusable(fixture, 'failed');

        expect(fixture.service.knownPeerIds()).toEqual(['z-peer']);
        expect(fixture.service.inFlightPeerIds()).toEqual([]);
    });

    it('emits onEstablished once per setup when both the connection and its lane report open', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const fixture = createFixture();
        const events: WebRtcConnectionService.PeerSetupEstablished[] = [];
        fixture.service.onRtcPeerLifecycleDo('test', {
            onCreated: () => {},
            onDeleted: () => {},
            onEstablished: (_peer, setup) => {
                events.push(setup);
            }
        });
        fixture.service.ensurePeerConnectionStarted('z-peer', true);
        vi.setSystemTime(1_250);
        const native = fixture.nativePeer('z-peer');

        native.setConnected();
        await native.channels[0].open();

        expect(events).toEqual([
            { phase: 'established', peerId: 'z-peer', startedAtEpochMs: 1_000, establishedAtEpochMs: 1_250 }
        ]);
    });

    it('ends the setup on removal and starts a fresh one for a replacement peer', () => {
        const fixture = createFixture();
        fixture.service.ensurePeerConnectionStarted('z-peer', true);
        fixture.service.removePeerIfPresent('z-peer');
        expect(fixture.service.inFlightPeerIds()).toEqual([]);

        expect(fixture.service.ensurePeerConnectionStarted('z-peer', true).right?.outcome).toBe('setup-started');
        expect(fixture.service.inFlightPeerIds()).toEqual(['z-peer']);
    });

    it('ends a setup whose lane start kills the connection and keeps its consumed attempt', () => {
        const fixture = createFixture(budgetInput());
        const lifecycle: string[] = [];
        fixture.service.onRtcPeerLifecycleDo('test', {
            onCreated: (peer) => {
                lifecycle.push(`created:${peer.peerId}`);
                for (const channel of peer.channels.values()) {
                    channel.connect = () => {
                        peer.connection.reset();
                        throw new Error('lane failed');
                    };
                }
            },
            onDeleted: (peer) => {
                lifecycle.push(`deleted:${peer.peerId}`);
            }
        });

        const failed = fixture.service.ensurePeerConnectionStarted('z-peer', true);

        expect(failed.left).toMatchObject({ kind: 'connect-failed', startedSetup: true });
        expect(isPeerSetupStarted(failed)).toBe(true);
        expect(lifecycle).toEqual(['created:z-peer', 'deleted:z-peer']);
        expect(fixture.service.knownPeerIds()).toEqual([]);
        expect(fixture.service.inFlightPeerIds()).toEqual([]);
        expect(fixture.service.peerConnectionAttemptDiagnostics('z-peer')?.attempts).toBe(1);
    });

    it('keeps a started setup dialing when a lane fails to start on a live connection', () => {
        const fixture = createFixture();
        fixture.service.onRtcPeerLifecycleDo('test', {
            onCreated: (peer) => {
                for (const channel of peer.channels.values()) {
                    channel.connect = () => {
                        throw new Error('lane failed');
                    };
                }
            },
            onDeleted: () => {}
        });

        const started = fixture.service.ensurePeerConnectionStarted('z-peer', true);

        expect(started.right).toMatchObject({ outcome: 'setup-started', peer: { peerId: 'z-peer' } });
        expect(isPeerSetupStarted(started)).toBe(true);
        expect(fixture.service.inFlightPeerIds()).toEqual(['z-peer']);
    });

    it('discards a peer whose native construction throws without any lifecycle notice', () => {
        const fixture = createFixture(budgetInput());
        const lifecycle: string[] = [];
        fixture.service.onRtcPeerLifecycleDo('test', {
            onCreated: (peer) => {
                lifecycle.push(`created:${peer.peerId}`);
            },
            onDeleted: (peer) => {
                lifecycle.push(`deleted:${peer.peerId}`);
            }
        });
        vi.stubGlobal(
            'RTCPeerConnection',
            class {
                constructor() {
                    throw new Error('ice configuration rejected');
                }
            }
        );

        const failed = fixture.service.ensurePeerConnectionStarted('z-peer', true);

        expect(failed.left).toMatchObject({ kind: 'connect-failed', startedSetup: false });
        expect(isPeerSetupStarted(failed)).toBe(false);
        expect(lifecycle).toEqual([]);
        expect(fixture.service.knownPeerIds()).toEqual([]);
        expect(fixture.service.inFlightPeerIds()).toEqual([]);
        expect(fixture.service.peerConnectionAttemptDiagnostics('z-peer')?.attempts).toBe(1);
    });
});

function makeNativePeerUnusable(fixture: NativeRtcConnectionFixture, state: 'failed' | 'reset'): void {
    if (state === 'reset') {
        const peer = fixture.service.readPeer('z-peer');
        if (!peer) {
            throw new Error('Expected the original peer');
        }
        peer.connection.reset();
        return;
    }
    const native = fixture.nativePeer('z-peer');
    native.connectionState = 'failed';
    native.onconnectionstatechange?.call(native, new Event('connectionstatechange'));
}
