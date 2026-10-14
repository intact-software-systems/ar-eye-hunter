import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { toRtcNativeObservationProjection } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts';
import { createBrowserRtcCapture } from '@shared-web/browser/rtc/create-browser-rtc-capture.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { RtcNativeObservationScope } from '@shared/webrtc/rtc-native-observation-scope.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { installNativeRtcRuntime, SimulatedNativeRtcPeerConnection } from '../native-rtc-connection-fixture.ts';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('original native owner evidence', () => {
    it.each(['native negotiation', 'application callback'] as const)(
        'publishes reset and replacement evidence while an old %s remains suspended',
        async (boundary) => {
            const runtime = installNativeRtcRuntime();
            const events: RtcSignalingDiagnostics.Event[] = [];
            const service = createService(events);
            const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
            if (!peer) {
                throw new Error('Expected started peer');
            }
            const original = runtime.createdConnections[0];
            const originalIdentity = peer.connection.getNativeIdentity();
            const entered = Promise.withResolvers<void>();
            const pending = Promise.withResolvers<void>();
            if (boundary === 'native negotiation') {
                original.setLocalDescription = () => {
                    entered.resolve();
                    return pending.promise;
                };
            }
            else {
                peer.connection.onDataChannelDo('suspended-consumer', () => {
                    entered.resolve();
                    return pending.promise;
                });
            }
            const operation = boundary === 'native negotiation'
                ? original.onnegotiationneeded?.call(original, new Event('negotiationneeded'))
                : original.receiveDataChannel('room');
            await entered.promise;
            try {
                events.length = 0;
                peer.connection.reset();
                peer.connection.connect();
                const replacementIdentity = peer.connection.getNativeIdentity();
                const replacement = runtime.createdConnections[1];
                const error = new Event('icecandidateerror');
                Object.defineProperty(error, 'errorCode', { value: 701 });
                replacement.dispatchEvent(error);
                expect(original.connectionState).toBe('closed');
                expect(peer.connection.status.pc).toBe(replacement);
                expect(peer.connection.readNativeSnapshot().firstError.status).toBe('observed');
                expect([...events]).toContainEqual(expect.objectContaining({
                    kind: 'native-lifetime',
                    action: 'retiring',
                    native: expect.objectContaining({ identity: originalIdentity })
                }));
                expect(events).toContainEqual(expect.objectContaining({
                    kind: 'native-first-error',
                    native: expect.objectContaining({ identity: replacementIdentity })
                }));
                service.disposeNativeObservations();
                const beforeSettlement = [...events];
                pending.resolve();
                await operation;
                expect(events).toEqual(beforeSettlement);
                expect(peer.connection.status.pc).toBe(replacement);
            }
            finally {
                pending.resolve();
                await operation;
                runtime.dispose();
            }
        }
    );

    it('does not let an old callback finally publish a replacement callback batch', async () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        if (!peer) {
            throw new Error('Expected peer');
        }
        const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        const pending = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        let callback = 0;
        peer.connection.onDataChannelDo('hold', () => {
            const index = callback++;
            entered[index].resolve();
            return pending[index].promise;
        });
        const original = runtime.createdConnections[0].receiveDataChannel('room');
        await entered[0].promise;
        peer.connection.reset();
        peer.connection.connect();
        const replacement = runtime.createdConnections[1].receiveDataChannel('room');
        await entered[1].promise;
        const replacementIdentity = peer.connection.getNativeIdentity();
        const createdChannels = () =>
            events.filter((row) =>
                row.kind === 'native-lifetime' && row.action === 'created' &&
                row.native.identity.channelId.status === 'observed' &&
                JSON.stringify(row.native.identity.peerConnectionId) === JSON.stringify(replacementIdentity.peerConnectionId)
            );
        try {
            expect(createdChannels()).toEqual([]);
            pending[0].resolve();
            await original;
            expect(createdChannels()).toEqual([]);
            const error = new Event('icecandidateerror');
            Object.defineProperty(error, 'errorCode', { value: 701 });
            runtime.createdConnections[1].dispatchEvent(error);
            expect(events).toContainEqual(
                expect.objectContaining({ kind: 'native-first-error', native: expect.objectContaining({ identity: replacementIdentity }) })
            );
            pending[1].resolve();
            await replacement;
            expect(createdChannels()).toHaveLength(1);
            expect(peer.connection.status.pc).toBe(runtime.createdConnections[1]);
        }
        finally {
            pending[0].resolve();
            pending[1].resolve();
            await original;
            await replacement;
            runtime.dispose();
        }
    });

    it('separates a synchronous callback replacement batch when the scope has no identity source', async () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events, {
            nativeObservation: RtcNativeObservationScope.create({}),
            nowEpochMs: () => 1,
            record: (row) => events.push(row)
        });
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        if (!peer) {
            throw new Error('Expected peer');
        }
        const pending = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        peer.connection.onDataChannelDo('replace-and-hold', () => {
            peer.connection.reset();
            peer.connection.connect();
            const error = new Event('icecandidateerror');
            Object.defineProperty(error, 'errorCode', { value: 701 });
            runtime.createdConnections[1].dispatchEvent(error);
            entered.resolve();
            return pending.promise;
        });
        events.length = 0;
        const operation = runtime.createdConnections[0].receiveDataChannel('room');
        await entered.promise;
        try {
            expect(runtime.createdConnections[0].connectionState).toBe('closed');
            expect(peer.connection.status.pc).toBe(runtime.createdConnections[1]);
            expect(peer.connection.readNativeSnapshot().firstError.status).toBe('observed');
            expect(events.some((row) => row.kind === 'native-first-error' && row.error.source === 'ice-candidate-error')).toBe(true);
        }
        finally {
            pending.resolve();
            await operation;
            runtime.dispose();
        }
    });

    it('retains a channel error and ended typed window after the original business callbacks finish', async () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        expect(peer).toBeDefined();
        const native = runtime.createdConnections[0].channels[0];
        const notifications: string[] = [];
        peer?.channel.onRtcCallbacksDo('observer', {
            onError: async () => {
                notifications.push('error');
            },
            onClose: async () => {
                notifications.push('close');
            }
        });
        await native.fail();
        expect(notifications).toEqual(['error', 'close']);
        expect(events.some((event) => event.kind === 'native-first-error' && event.error.source === 'channel-error')).toBe(true);
        expect(events).toContainEqual(expect.objectContaining({
            kind: 'native-lifetime',
            action: 'retiring',
            retirement: 'channel-error',
            native: expect.objectContaining({
                firstError: expect.objectContaining({ status: 'observed', coverage: expect.objectContaining({ window: 'ended-at-retirement' }) })
            })
        }));
        const before = JSON.stringify(events);
        native.dispatchEvent(new Event('error'));
        expect(JSON.stringify(events)).toBe(before);
        service.disconnectPeer('z-peer');
        runtime.dispose();
    });

    it('keeps admitted terminal errors after ordinary exhaustion without suppressing later native work', async () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const capture = createBrowserRtcCapture({
            configuration: { mode: 'native', origin: 'step' },
            connectionId: { status: 'observed', value: 'connection' },
            nowEpochMs: () => 1,
            record: (event) => events.push(event)
        });
        const service = createService(events, capture.diagnostics);
        service.ensurePeerConnectionStarted('z-peer', true);
        const capability = capture.diagnostics?.nativeObservation;
        if (capability?.status !== 'available') {
            throw new Error('Expected native scope');
        }
        for (let row = 0; row < 4_100; row++) {
            capability.scope.consumeOrdinary();
        }
        await runtime.createdConnections[0].channels[0].fail();
        service.disconnectPeer('z-peer');
        expect(events).toContainEqual(
            expect.objectContaining({
                kind: 'native-lifetime',
                action: 'retiring',
                native: expect.objectContaining({
                    firstError: expect.objectContaining({ status: 'observed' }),
                    capture: expect.objectContaining({ ordinaryRowsSuppressed: true })
                })
            })
        );
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        expect(peer?.connection.status.pc).toBe(runtime.createdConnections[1]);
        expect(runtime.createdConnections[1].channels).toHaveLength(1);
        service.disconnectPeer('z-peer');
        runtime.dispose();
    });

    it('ends an original channel read as unavailable when its getter synchronously resets it', async () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        if (!peer) {
            throw new Error('Expected started peer');
        }
        const native = runtime.createdConnections[0].channels[0];
        let state: RTCDataChannelState = native.readyState;
        let retire = true;
        Object.defineProperty(native, 'readyState', {
            get: () => {
                if (retire) {
                    retire = false;
                    peer.channel.reset();
                }
                return state;
            },
            set: (value: RTCDataChannelState) => {
                state = value;
            }
        });
        events.length = 0;
        await native.open();
        expect(peer.channel.status.dc).toBeUndefined();
        expect(state).toBe('closed');
        const finals = events.filter((event) => event.kind === 'native-lifetime' && event.action === 'retiring');
        expect(finals).toHaveLength(1);
        expect(finals[0]).toMatchObject({
            native: {
                state: {
                    connectionState: { status: 'unavailable', reason: 'read-failed' },
                    iceConnectionState: { status: 'unavailable', reason: 'read-failed' },
                    channelState: { status: 'unavailable', reason: 'read-failed' }
                }
            }
        });
        expect(events.some((event) => event.kind === 'native-state' && event.trigger === 'channel-open')).toBe(false);
        service.disconnectPeer('z-peer');
        service.ensurePeerConnectionStarted('z-peer', true);
        events.length = 0;
        await runtime.createdConnections[1].channels[0].open();
        expect(events).toContainEqual(
            expect.objectContaining({
                kind: 'native-state',
                trigger: 'channel-open',
                native: expect.objectContaining({ state: expect.objectContaining({ channelState: { status: 'observed', value: 'open' } }) })
            })
        );
        runtime.dispose();
    });

    it('retains ended unavailable error coverage when an error getter retires the original PC', () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        if (!peer) {
            throw new Error('Expected started peer');
        }
        const original = runtime.createdConnections[0];
        const event = new Event('icecandidateerror');
        Object.defineProperty(event, 'error', {
            get: () => {
                peer.connection.reset();
                peer.connection.connect();
                return { errorCode: 701 };
            }
        });
        events.length = 0;
        original.dispatchEvent(event);
        expect(original.connectionState).toBe('closed');
        expect(peer.connection.status.pc).toBe(runtime.createdConnections[1]);
        const finals = events.filter((row) => row.kind === 'native-lifetime' && row.action === 'retiring');
        expect(finals).toHaveLength(1);
        expect(finals[0]).toMatchObject({
            native: {
                firstError: { status: 'unavailable', reason: 'read-failed', coverage: { window: 'ended-at-retirement' } },
                firstTypedError: { status: 'unavailable', reason: 'read-failed', coverage: { window: 'ended-at-retirement' } }
            }
        });
        events.length = 0;
        const replacementError = new Event('icecandidateerror');
        Object.defineProperty(replacementError, 'errorCode', { value: 701 });
        runtime.createdConnections[1].dispatchEvent(replacementError);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'native-first-error', first: 'both' }));
        runtime.dispose();
    });

    it('ends the original error window during a queued rejection getter and continues its spliced native FIFO', async () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        if (!peer) {
            throw new Error('Expected started peer');
        }
        const original = runtime.createdConnections[0];
        const attempted: string[] = [];
        const failure = new Error('private-message');
        let nested = false;
        Object.defineProperty(failure, 'errorDetail', {
            get: () => {
                if (!nested) {
                    nested = true;
                    original.dispatchEvent(new Event('icecandidateerror'));
                    peer.connection.reset();
                    peer.connection.connect();
                }
                return 'sctp-failure';
            }
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(original, 'addIceCandidate').mockImplementation(async (candidate) => {
            attempted.push(candidate?.candidate ?? '');
            if (candidate?.candidate === 'first') {
                throw failure;
            }
        });
        for (const candidate of ['first', 'last']) {
            await peer.connection.handleSignal({ signalType: 'IceCandidate', payload: { description: null, candidate: { candidate } } });
        }
        events.length = 0;
        await peer.connection.handleSignal({
            signalType: 'Offer',
            offerId: 'offer',
            payload: { description: { type: 'offer', sdp: 'private-sdp' }, candidate: null }
        });
        expect(attempted).toEqual(['first', 'last']);
        expect(original.connectionState).toBe('closed');
        expect(peer.connection.status.pc).toBe(runtime.createdConnections[1]);
        const finals = JSON.parse(JSON.stringify(events.filter((row) => row.kind === 'native-lifetime' && row.action === 'retiring')));
        expect(finals).toHaveLength(1);
        expect(finals[0].native.firstTypedError).toMatchObject({ status: 'unavailable', reason: 'read-failed', coverage: { window: 'ended-at-retirement' } });
        expect(
            events.filter((row) => row.kind === 'native-candidate-application').map((row) =>
                row.kind === 'native-candidate-application' ? [row.candidate.applicationOrdinal, row.candidate.stage] : []
            )
        ).toEqual([[0, 'submitted'], [0, 'rejected'], [1, 'submitted'], [1, 'returned']]);
        events.length = 0;
        const replacementError = new Event('icecandidateerror');
        Object.defineProperty(replacementError, 'errorCode', { value: 701 });
        runtime.createdConnections[1].dispatchEvent(replacementError);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'native-first-error', first: 'both' }));
        runtime.dispose();
    });

    it('retains an outbound native description rejection before reporting the original signaling failure', async () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        if (!peer) {
            throw new Error('Expected started peer');
        }
        const original = runtime.createdConnections[0];
        const failure = new DOMException('private-outbound', 'OperationError');
        vi.spyOn(original, 'setLocalDescription').mockRejectedValue(failure);
        await original.onnegotiationneeded?.call(original, new Event('negotiationneeded'));
        service.disconnectPeer('z-peer');
        expect(events).toContainEqual(
            expect.objectContaining({
                kind: 'native-lifetime',
                action: 'retiring',
                native: expect.objectContaining({
                    firstError: expect.objectContaining({ status: 'observed', value: expect.objectContaining({ source: 'description-rejection' }) })
                })
            })
        );
        expect(JSON.stringify(events)).not.toContain('private-outbound');
        runtime.dispose();
    });

    it.each(['description', 'candidate'] as const)(
        'serializes witnessed %s rejection in final and service snapshots without an error listener',
        async (operation) => {
            const runtime = installNativeRtcRuntime();
            const events: RtcSignalingDiagnostics.Event[] = [];
            const add = EventTarget.prototype.addEventListener;
            vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (this: EventTarget, type, callback, options) {
                if (type === 'icecandidateerror') {
                    throw new Error('listener unavailable');
                }
                return add.call(this, type, callback, options);
            });
            const service = createService(events);
            const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
            if (!peer) {
                throw new Error('Expected started peer');
            }
            const native = runtime.createdConnections[0];
            const failure = new DOMException('private-operation', 'OperationError');
            if (operation === 'description') {
                vi.spyOn(native, 'setRemoteDescription').mockRejectedValue(failure);
                await expect(peer.connection.handleSignal({
                    signalType: 'Offer',
                    offerId: 'offer',
                    payload: { description: { type: 'offer', sdp: 'private-sdp' }, candidate: null }
                })).rejects.toBe(failure);
            }
            else {
                await native.setRemoteDescription({ type: 'offer' });
                vi.spyOn(native, 'addIceCandidate').mockRejectedValue(failure);
                await expect(peer.connection.handleSignal({
                    signalType: 'IceCandidate',
                    payload: { description: null, candidate: { candidate: 'private-candidate' } }
                })).rejects.toBe(failure);
            }
            service.disconnectPeer('z-peer');
            const rows = events.filter((row) =>
                (row.kind === 'native-lifetime' && row.action === 'retiring' && row.native.identity.channelId.status === 'unavailable') ||
                (row.kind === 'service-peer-observation' && row.service.stage === 'terminating')
            );
            expect(rows).toHaveLength(2);
            for (const row of rows) {
                const projected = toRtcNativeObservationProjection(JSON.parse(JSON.stringify(row)));
                expect(projected.event).toBeDefined();
                const snapshot = row.kind === 'native-lifetime' ? row.native : row.kind === 'service-peer-observation' ? row.service.native : undefined;
                expect(snapshot?.firstError).toMatchObject({
                    status: 'observed',
                    coverage: { kind: 'native-operation', stage: 'settled' },
                    value: { source: `${operation}-rejection`, exceptionName: { status: 'observed', value: 'OperationError' } }
                });
            }
            expect(JSON.stringify(rows)).not.toContain('private-');
            expect(native.connectionState).toBe('closed');
            runtime.dispose();
        }
    );

    it('keeps independent operation and listener provenance for the first generic and later typed error', async () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        if (!peer) {
            throw new Error('Expected peer');
        }
        const native = runtime.createdConnections[0];
        const failure = new DOMException('private-description', 'OperationError');
        vi.spyOn(native, 'setRemoteDescription').mockRejectedValue(failure);
        await expect(peer.connection.handleSignal({
            signalType: 'Offer',
            offerId: 'offer',
            payload: { description: { type: 'offer', sdp: 'private-sdp' }, candidate: null }
        })).rejects.toBe(failure);
        await native.channels[0].fail();
        service.disconnectPeer('z-peer');
        const final = events.find((row) =>
            row.kind === 'native-lifetime' && row.action === 'retiring' && row.native.identity.channelId.status === 'unavailable'
        );
        expect(final).toMatchObject({
            native: {
                firstError: { status: 'observed', value: { source: 'description-rejection' }, coverage: { kind: 'native-operation', stage: 'settled' } },
                firstTypedError: {
                    status: 'observed',
                    value: { source: 'channel-error' },
                    coverage: { kind: 'listener-window', window: 'ended-at-retirement' }
                }
            }
        });
        expect(toRtcNativeObservationProjection(JSON.parse(JSON.stringify(final))).event).toBeDefined();
        runtime.dispose();
    });

    it.each(['channel', 'peer'] as const)(
        'retains failed typed-read availability after a throwing %s error getter completes',
        async (source) => {
            const runtime = installNativeRtcRuntime();
            vi.stubGlobal('RTCError', DOMException);
            const events: RtcSignalingDiagnostics.Event[] = [];
            const service = createService(events);
            const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
            if (!peer) {
                throw new Error('Expected started peer');
            }
            const native = runtime.createdConnections[0];
            let reads = 0;
            const event = new class extends Event implements RTCErrorEvent {
                get error(): RTCError {
                    reads++;
                    throw new Error('private-failed-read');
                }
            }(source === 'channel' ? 'error' : 'icecandidateerror');
            if (source === 'channel') {
                await native.channels[0].onerror?.call(native.channels[0], event);
                expect(peer.channel.status.dc).toBeUndefined();
            }
            else {
                native.dispatchEvent(event);
            }
            expect(reads).toBe(1);
            expect(peer.connection.status.pc).toBe(native);
            service.disconnectPeer('z-peer');
            const finals = events.filter((row) => row.kind === 'native-lifetime' && row.action === 'retiring');
            const affected = finals.filter((row) => row.native.firstError.status === 'observed');
            expect(affected).toHaveLength(source === 'channel' ? 2 : 1);
            for (const row of affected) {
                expect(row.native.firstTypedError).toMatchObject({
                    status: 'unavailable',
                    reason: 'read-failed',
                    coverage: { kind: 'listener-window', window: 'ended-at-retirement' }
                });
                expect(toRtcNativeObservationProjection(JSON.parse(JSON.stringify(row))).event).toBeDefined();
                expect(row.native.firstError.status).toBe('observed');
            }
            expect(JSON.stringify(finals)).not.toContain('private-failed-read');
            expect(native.connectionState).toBe('closed');
            runtime.dispose();
        }
    );

    it('reports PC admission denial in a still-admitted setup without denying native recreation or reading it', () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        const scope = peer?.connection.getNativeObservationScope();
        if (!peer || !scope) {
            throw new Error('Expected started native peer');
        }
        for (let pc = 1; pc < 256; pc++) {
            scope.allocate('pc');
        }
        const NativePeer = globalThis.RTCPeerConnection;
        let nativeReads = 0;
        vi.stubGlobal(
            'RTCPeerConnection',
            class extends NativePeer {
                constructor(configuration?: RTCConfiguration) {
                    super(configuration);
                    Object.defineProperty(this, 'sctp', {
                        get: () => {
                            nativeReads++;
                            throw new Error('must not read unadmitted native');
                        }
                    });
                }
            }
        );
        peer.connection.reset();
        peer.connection.connect();
        expect(runtime.createdConnections).toHaveLength(2);
        expect(runtime.createdConnections[0].connectionState).toBe('closed');
        expect(peer.connection.status.pc).toBe(runtime.createdConnections[1]);
        expect(peer.connection.getNativeIdentity().peerConnectionId).toEqual({ status: 'unavailable', reason: 'admission-limit' });
        service.disconnectPeer('z-peer');
        const terminal = events.find((row) => row.kind === 'service-peer-observation' && row.service.stage === 'terminating');
        expect(terminal).toMatchObject({
            service: {
                native: {
                    identity: { peerConnectionId: { status: 'unavailable', reason: 'admission-limit' } },
                    state: { connectionState: { status: 'unavailable', reason: 'admission-limit' } },
                    firstError: { status: 'unavailable', reason: 'admission-limit' },
                    firstTypedError: { status: 'unavailable', reason: 'admission-limit' }
                }
            }
        });
        expect(toRtcNativeObservationProjection(JSON.parse(JSON.stringify(terminal))).event).toBeDefined();
        expect(nativeReads).toBe(0);
        expect(runtime.createdConnections[1].connectionState).toBe('closed');
        runtime.dispose();
    });

    it.each(['unsupported', 'read-failed'] as const)(
        'keeps the captured parent %s transport reason in channel JSON snapshots',
        (reason) => {
            const runtime = installNativeRtcRuntime();
            const NativePeer = globalThis.RTCPeerConnection;
            vi.stubGlobal(
                'RTCPeerConnection',
                class extends NativePeer {
                    constructor(configuration?: RTCConfiguration) {
                        super(configuration);
                        if (reason === 'unsupported') {
                            Reflect.deleteProperty(this, 'sctp');
                        }
                        else {
                            Object.defineProperty(this, 'sctp', {
                                get: () => {
                                    throw new Error('private-transport');
                                }
                            });
                        }
                    }
                }
            );
            const events: RtcSignalingDiagnostics.Event[] = [];
            const service = createService(events);
            const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
            expect(peer?.channel.status.dc).toBe(runtime.createdConnections[0].channels[0]);
            const created = events.find((row) =>
                row.kind === 'native-lifetime' && row.action === 'created' && row.native.identity.channelId.status === 'observed'
            );
            expect(created).toMatchObject({
                native: {
                    state: {
                        channelState: { status: 'observed', value: 'connecting' },
                        iceTransportState: { status: 'unavailable', reason },
                        dtlsState: { status: 'unavailable', reason },
                        sctpState: { status: 'unavailable', reason }
                    }
                }
            });
            expect(toRtcNativeObservationProjection(JSON.parse(JSON.stringify(created))).event).toBeDefined();
            service.disconnectPeer('z-peer');
            expect(runtime.createdConnections[0].connectionState).toBe('closed');
            expect(JSON.stringify(events)).not.toContain('private-transport');
            runtime.dispose();
        }
    );

    it('does not claim an error window merely because state listeners attached', () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const add = EventTarget.prototype.addEventListener;
        vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (this: EventTarget, type, callback, options) {
            if (type === 'icecandidateerror') {
                throw new Error('unsupported error listener');
            }
            return add.call(this, type, callback, options);
        });
        const service = createService(events);
        service.ensurePeerConnectionStarted('z-peer', true);
        const created = events.find((row) => row.kind === 'native-lifetime' && row.action === 'created');
        expect(created).toMatchObject({
            native: { firstError: { status: 'unavailable', reason: 'read-failed', coverage: { kind: 'unavailable', reason: 'read-failed' } } }
        });
        service.disconnectPeer('z-peer');
        runtime.dispose();
    });

    it('retains the original description rejection without exposing native error text', async () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        if (!peer) {
            throw new Error('Expected started peer');
        }
        const failure = new DOMException('private-error-message', 'OperationError');
        vi.spyOn(runtime.createdConnections[0], 'setRemoteDescription').mockRejectedValue(failure);
        await expect(
            peer.connection.handleSignal({
                signalType: 'Offer',
                offerId: 'offer',
                payload: { description: { type: 'offer', sdp: 'private-sdp' }, candidate: null }
            })
        ).rejects.toBe(failure);
        service.disconnectPeer('z-peer');
        expect(events).toContainEqual(
            expect.objectContaining({
                kind: 'native-lifetime',
                action: 'retiring',
                native: expect.objectContaining({
                    firstError: expect.objectContaining({
                        status: 'observed',
                        value: expect.objectContaining({ source: 'description-rejection', exceptionName: { status: 'observed', value: 'OperationError' } })
                    })
                })
            })
        );
        expect(JSON.stringify(events)).not.toContain('private-error-message');
        runtime.dispose();
    });

    it('keeps the original native identity on caller release and late signal completion', async () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        if (!peer) {
            throw new Error('Expected started peer');
        }
        const identity = peer.connection.getNativeIdentity();
        const description = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        vi.spyOn(runtime.createdConnections[0], 'setRemoteDescription').mockImplementation(() => {
            entered.resolve();
            return description.promise;
        });
        const applying = peer.connection.handleSignal({
            signalType: 'Offer',
            offerId: 'offer',
            payload: { description: { type: 'offer', sdp: 'private-sdp' }, candidate: null }
        });
        await entered.promise;
        peer.connection.reset();
        peer.connection.connect();
        await applying;
        description.resolve();
        await vi.waitFor(() =>
            expect(events).toContainEqual(
                expect.objectContaining({ kind: 'native-signal-decision', disposition: 'application-returned', nativeIdentity: identity })
            )
        );
        expect(events).toContainEqual(expect.objectContaining({ kind: 'signal-caller-release', disposition: 'lifetime-retired', nativeIdentity: identity }));
        runtime.dispose();
    });

    it('keeps a replacement channel when an original retirement getter synchronously reconnects', () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        if (!peer) {
            throw new Error('Expected started peer');
        }
        const native = runtime.createdConnections[0].channels[0];
        let state: RTCDataChannelState = native.readyState;
        let replace = true;
        Object.defineProperty(native, 'readyState', {
            get: () => {
                if (replace) {
                    replace = false;
                    peer.channel.reset();
                    peer.channel.connect(true);
                }
                return state;
            },
            set: (value: RTCDataChannelState) => {
                state = value;
            }
        });
        peer.channel.reset();
        expect(peer.channel.status.dc).toBe(runtime.createdConnections[0].channels[1]);
        expect(peer.channel.status.dc?.readyState).toBe('connecting');
        runtime.dispose();
    });

    it('records the issuer that actually deletes the original peer during a state getter', () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const originalPeer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        const deleted: WebRtcConnectionService.Peer[] = [];
        service.onRtcPeerLifecycleDo('deletion', {
            onCreated: () => {},
            onDeleted: (peer) => {
                deleted.push(peer);
            }
        });
        const original = runtime.createdConnections[0];
        let remove = true;
        Object.defineProperty(original, 'iceConnectionState', {
            get: () => {
                if (remove) {
                    remove = false;
                    service.disconnectPeer('z-peer');
                    service.ensurePeerConnectionStarted('z-peer', true);
                }
                return 'new';
            },
            set: () => {}
        });
        service.removePeerIfPresent('z-peer');
        expect(deleted).toEqual([originalPeer]);
        expect(service.readPeer('z-peer')?.connection.status.pc).toBe(runtime.createdConnections[1]);
        const termination = events.filter((row) => row.kind === 'service-peer-observation' && row.service.stage === 'terminating');
        expect(termination).toHaveLength(1);
        expect(termination[0]).toMatchObject({ service: { issuer: { status: 'observed', value: 'disconnect-peer' } } });
        runtime.dispose();
    });

    it('binds the data transport discovered by native channel creation before capturing that channel', () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const createChannel = SimulatedNativeRtcPeerConnection.prototype.createDataChannel;
        vi.spyOn(SimulatedNativeRtcPeerConnection.prototype, 'createDataChannel').mockImplementation(
            function (this: SimulatedNativeRtcPeerConnection, label, options) {
                const channel = createChannel.call(this, label, options);
                const ice = Object.assign(new EventTarget(), { state: 'new' });
                const dtls = Object.assign(new EventTarget(), { state: 'new', iceTransport: ice });
                Object.defineProperty(this, 'sctp', { configurable: true, value: Object.assign(new EventTarget(), { state: 'connecting', transport: dtls }) });
                return channel;
            }
        );
        const service = createService(events);
        service.ensurePeerConnectionStarted('z-peer', true);
        expect(events).toContainEqual(
            expect.objectContaining({
                kind: 'native-lifetime',
                action: 'created',
                native: expect.objectContaining({
                    identity: expect.objectContaining({ channelId: expect.objectContaining({ status: 'observed' }) }),
                    state: expect.objectContaining({
                        iceTransportState: { status: 'observed', value: 'new' },
                        transportObjectOrdinal: { status: 'observed', value: 1 }
                    })
                })
            })
        );
        service.disconnectPeer('z-peer');
        runtime.dispose();
    });

    it('does not join a replacement PC into a service snapshot after a channel getter reconnects the original owner', () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        if (!peer) {
            throw new Error('Expected started peer');
        }
        const identity = peer.connection.getNativeIdentity();
        const channel = runtime.createdConnections[0].channels[0];
        let state = channel.readyState;
        let replace = true;
        Object.defineProperty(channel, 'readyState', {
            get: () => {
                if (replace) {
                    replace = false;
                    peer.connection.reset();
                    peer.connection.connect();
                }
                return state;
            },
            set: (value: RTCDataChannelState) => {
                state = value;
            }
        });
        events.length = 0;
        service.disconnectPeer('z-peer');
        const terminating = events.find((row) => row.kind === 'service-peer-observation' && row.service.stage === 'terminating');
        expect(terminating).toMatchObject({ service: { native: { identity } } });
        expect(service.readPeer('z-peer')).toBeUndefined();
        runtime.dispose();
    });

    it('does not join a same-PC replacement channel into the original service capture', () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        if (!peer) {
            throw new Error('Expected started peer');
        }
        const pc = runtime.createdConnections[0];
        let replace = true;
        Object.defineProperty(pc, 'iceConnectionState', {
            get: () => {
                if (replace) {
                    replace = false;
                    peer.channel.reset();
                    peer.channel.connect(true);
                }
                return 'new';
            },
            set: () => {}
        });
        events.length = 0;
        service.disconnectPeer('z-peer');
        expect(runtime.createdConnections).toHaveLength(1);
        expect(pc.channels).toHaveLength(2);
        const terminating = events.find((row) => row.kind === 'service-peer-observation' && row.service.stage === 'terminating');
        expect(JSON.parse(JSON.stringify(terminating))).toMatchObject({ service: { channelCount: 1, channels: [], channelsTruncated: true } });
        expect(service.readPeer('z-peer')).toBeUndefined();
        runtime.dispose();
    });

    it('marks the original parent read while a channel snapshot getter retires and replaces that PC', async () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        if (!peer) {
            throw new Error('Expected started peer');
        }
        const original = runtime.createdConnections[0];
        let replace = true;
        Object.defineProperty(original, 'iceConnectionState', {
            get: () => {
                if (replace) {
                    replace = false;
                    peer.connection.reset();
                    peer.connection.connect();
                }
                return 'new';
            },
            set: () => {}
        });
        events.length = 0;
        await original.channels[0].open();
        const finals = JSON.parse(JSON.stringify(events.filter((row) => row.kind === 'native-lifetime' && row.action === 'retiring')));
        expect(finals[0].native.state).toMatchObject({
            connectionState: { status: 'unavailable', reason: 'read-failed' },
            iceConnectionState: { status: 'unavailable', reason: 'read-failed' },
            channelState: { status: 'unavailable', reason: 'read-failed' }
        });
        expect(events.some((row) => row.kind === 'native-state' && row.trigger === 'channel-open')).toBe(false);
        expect(original.connectionState).toBe('closed');
        expect(peer.connection.status.pc).toBe(runtime.createdConnections[1]);
        events.length = 0;
        const error = new Event('icecandidateerror');
        Object.defineProperty(error, 'errorCode', { value: 701 });
        runtime.createdConnections[1].dispatchEvent(error);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'native-first-error', first: 'both' }));
        runtime.dispose();
    });

    it('tracks exact transport attachment and finite candidate equality without retaining fragment values', async () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        if (!peer) {
            throw new Error('Expected started peer');
        }
        const native = runtime.createdConnections[0];
        const ice = Object.assign(new EventTarget(), {
            state: 'new',
            getRemoteParameters: () => ({ usernameFragment: 'private-fragment', password: 'private-password' })
        });
        const dtls = Object.assign(new EventTarget(), { state: 'new', iceTransport: ice });
        const sctp = Object.assign(new EventTarget(), { state: 'connecting', transport: dtls });
        Object.defineProperty(native, 'sctp', { configurable: true, value: sctp });
        native.dispatchEvent(new Event('signalingstatechange'));
        expect(peer.connection.readNativeSnapshot().state).toMatchObject({ transportObjectOrdinal: { status: 'observed', value: 1 }, attachmentGap: false });
        await native.setRemoteDescription({ type: 'offer', sdp: 'private-sdp' });
        await peer.connection.handleSignal({
            signalType: 'IceCandidate',
            payload: { description: null, candidate: { candidate: 'private-address', usernameFragment: 'private-fragment' } }
        });
        const candidates = events.filter((row) => row.kind === 'native-candidate-application');
        expect(candidates).toHaveLength(2);
        expect(candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    candidate: expect.objectContaining({
                        stage: 'submitted',
                        fragmentPresence: 'present',
                        dataIceFragmentComparison: 'equal',
                        targetTransportAssociation: 'unknown',
                        iceGenerationAssociation: 'unknown'
                    })
                })
            ])
        );
        const replacementIce = Object.assign(new EventTarget(), { state: 'connected' });
        Object.defineProperty(native, 'sctp', {
            configurable: true,
            value: Object.assign(new EventTarget(), {
                state: 'connected',
                transport: Object.assign(new EventTarget(), { state: 'connected', iceTransport: replacementIce })
            })
        });
        native.dispatchEvent(new Event('signalingstatechange'));
        expect(peer.connection.readNativeSnapshot().state).toMatchObject({ transportObjectOrdinal: { status: 'observed', value: 2 }, attachmentGap: true });
        const before = events.length;
        ice.state = 'failed';
        ice.dispatchEvent(new Event('statechange'));
        expect(events).toHaveLength(before);
        expect(JSON.stringify(events)).not.toContain('private-');
        Object.defineProperty(native, 'sctp', {
            get: () => {
                throw new Error('private-getter');
            }
        });
        native.dispatchEvent(new Event('signalingstatechange'));
        expect(peer.connection.readNativeSnapshot().state.sctpState).toEqual({ status: 'unavailable', reason: 'read-failed' });
        runtime.dispose();
    });

    it('reports unavailable error windows when native observer attachment fails without denying setup', () => {
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        vi.spyOn(SimulatedNativeRtcPeerConnection.prototype, 'addEventListener').mockImplementation(() => {
            throw new Error('attachment unavailable');
        });
        const service = createService(events);
        const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        expect(peer?.connection.status.pc).toBe(runtime.createdConnections[0]);
        expect(peer?.connection.readNativeSnapshot()).toMatchObject({
            firstError: { status: 'unavailable', reason: 'read-failed', coverage: { kind: 'unavailable', reason: 'read-failed' } }
        });
        expect(runtime.createdConnections[0].channels).toHaveLength(1);
        runtime.dispose();
    });

    it('does not inspect extra native properties when capture is disabled', () => {
        const runtime = installNativeRtcRuntime();
        let reads = 0;
        vi.stubGlobal(
            'RTCPeerConnection',
            class extends SimulatedNativeRtcPeerConnection {
                constructor() {
                    super();
                    Object.defineProperty(this, 'sctp', {
                        get: () => {
                            reads++;
                            throw new Error('native unsupported');
                        }
                    });
                }
            }
        );
        const service = new WebRtcConnectionService({ connect: async () => {}, send: async () => {} }, {
            sessionId: 'self',
            token: 'test',
            dataChannelName: 'test',
            rtcSignalingTopicId: 'rtc',
            iceCandidates: { iceServers: [], expiresAtEpochMs: 1000 }
        }, { nowEpochMs: () => 1, createOfferId: () => 'offer', faultPort: createPassThroughTransportFaultPort() });
        onTestFinished(() => {
            service.disconnectPeer('peer');
        });
        service.ensurePeerConnectionStarted('peer', true);
        service.disconnectPeer('peer');
        expect(reads).toBe(0);
        runtime.dispose();
    });

    it('retains the original timeout and actual deletion issuer when an observer replaces its peer', async () => {
        vi.useFakeTimers();
        const runtime = installNativeRtcRuntime();
        const events: RtcSignalingDiagnostics.Event[] = [];
        const service = createService(events);
        const original = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
        service.onRtcPeerLifecycleDo('replace', {
            onCreated: () => {},
            onDeleted: () => {},
            onConnectTimeout: () => {
                service.disconnectPeer('z-peer');
                service.ensurePeerConnectionStarted('z-peer', true);
            }
        });
        await vi.advanceTimersByTimeAsync(50);
        expect(service.readPeer('z-peer')).not.toBe(original);
        expect(events).toContainEqual(
            expect.objectContaining({
                kind: 'service-peer-observation',
                service: expect.objectContaining({ stage: 'establishment-timeout', removalDisposition: 'original-no-longer-current' })
            })
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                kind: 'service-peer-observation',
                service: expect.objectContaining({ stage: 'terminating', issuer: { status: 'observed', value: 'disconnect-peer' } })
            })
        );
        service.disconnectPeer('z-peer');
        runtime.dispose();
    });
});

function createService(events: RtcSignalingDiagnostics.Event[], diagnostics?: RtcSignalingDiagnostics): WebRtcConnectionService {
    const capture = diagnostics ? undefined : createBrowserRtcCapture({
        configuration: { mode: 'native', origin: 'step' },
        connectionId: { status: 'observed', value: 'connection' },
        nowEpochMs: () => 1,
        record: (event) => events.push(event)
    });
    const service = new WebRtcConnectionService({ connect: async () => {}, send: async () => {} }, {
        sessionId: 'a-self',
        token: 'private-token',
        dataChannelName: 'room',
        rtcSignalingTopicId: 'rtc',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 1_000 },
        peerEstablishmentTimeout: { enabled: true, timeoutMs: 50 }
    }, {
        createOfferId: () => 'offer',
        faultPort: createPassThroughTransportFaultPort(),
        nowEpochMs: () => 1,
        signalingDiagnostics: diagnostics ?? capture?.diagnostics
    });
    onTestFinished(() => {
        for (const peerId of service.knownPeerIds()) {
            service.disconnectPeer(peerId);
        }
        service.disposeNativeObservations();
    });
    return service;
}
