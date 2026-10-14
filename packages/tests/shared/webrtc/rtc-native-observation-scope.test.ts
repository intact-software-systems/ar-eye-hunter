import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { toRtcNativeObservationProjection } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts';
import { createBrowserRtcCapture } from '@shared-web/browser/rtc/create-browser-rtc-capture.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { RtcNativeObservationScope } from '@shared/webrtc/rtc-native-observation-scope.ts';
import { recordRtcNativeObservation, type RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import { installNativeRtcRuntime } from '../native-rtc-connection-fixture.ts';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('native scope construction and admission', () => {
    it('constructs one completed native scope before returning an applied receipt', () => {
        const nonces: string[] = [];
        vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
            nonces.push('scope');
            return '00000000-0000-4000-8000-000000000001';
        });
        const capture = createBrowserRtcCapture({
            configuration: { mode: 'native', origin: 'step' },
            connectionId: { status: 'observed', value: 'connection' },
            nowEpochMs: () => 1,
            record: () => {}
        });
        expect(capture.receipt.application).toEqual({ status: 'applied', mode: 'native' });
        expect(nonces).toEqual(['scope']);
        expect(capture.receipt.nativeScopeId).toEqual({ status: 'observed', value: '00000000-0000-4000-8000-000000000001' });
    });
});

it('keeps each terminal entitlement separate and denies reuse without spending another owner final', () => {
    const capture = createBrowserRtcCapture({
        configuration: { mode: 'native', origin: 'step' },
        connectionId: { status: 'observed', value: 'connection' },
        nowEpochMs: () => 1,
        record: () => {}
    });
    const capability = capture.diagnostics?.nativeObservation;
    expect(capability?.status).toBe('available');
    if (capability?.status !== 'available') {
        return;
    }
    const scope = capability.scope;
    const first = scope.allocate('pc');
    const second = scope.allocate('pc');
    expect(scope.consumeTerminal(first, 'final')).toBe(true);
    expect(scope.consumeTerminal(first, 'final')).toBe(false);
    expect(scope.consumeTerminal(second, 'final')).toBe(true);
});

it('keeps the fixed retention stress allowance and total attempts finite across reused scope cycles', () => {
    const capability = RtcNativeObservationScope.create({ createScopeId: () => 'persistent-A' });
    if (capability.status !== 'available') {
        throw new Error('Scope construction failed');
    }
    const scope = capability.scope;
    const setups = [];
    const pcs = [];
    const channels = [];
    for (let cycle = 0; cycle < 204; cycle++) {
        setups.push(scope.allocate('setup'));
        pcs.push(scope.allocate('pc'));
        for (let channel = 0; channel < 4; channel++) {
            channels.push(scope.allocate('channel'));
        }
    }
    expect([...setups, ...pcs, ...channels].every((admission) => admission.admitted)).toBe(true);
    expect(new Set([...setups, ...pcs, ...channels].map((admission) => JSON.stringify(admission.id))).size).toBe(1_224);
    for (let remaining = 0; remaining < 52; remaining++) {
        setups.push(scope.allocate('setup'));
        pcs.push(scope.allocate('pc'));
    }
    for (let remaining = 0; remaining < 208; remaining++) {
        channels.push(scope.allocate('channel'));
    }
    for (const kind of ['setup', 'pc', 'channel'] as const) {
        expect(scope.allocate(kind)).toMatchObject({ admitted: false, id: { status: 'unavailable', reason: 'admission-limit' } });
    }
    let attempts = 0;
    for (let row = 0; row < 10_000; row++) {
        if (scope.consumeOrdinary()) {
            attempts++;
        }
    }
    expect(attempts).toBe(4_096);
    for (const setup of setups) {
        if (scope.consumeTerminal(setup, 'timeout')) {
            attempts++;
        }
        if (scope.consumeTerminal(setup, 'final')) {
            attempts++;
        }
    }
    for (const native of [...pcs, ...channels]) {
        if (scope.consumeTerminal(native, 'final')) {
            attempts++;
        }
        expect(scope.consumeTerminal(native, 'timeout')).toBe(false);
    }
    expect(attempts).toBe(5_888);
    if (scope.consumeStatus('initialized')) {
        attempts++;
    }
    if (scope.consumeLimitNotice()) {
        attempts++;
    }
    expect(scope.consumeLimitNotice()).toBeUndefined();
    const disposed = scope.dispose();
    if (scope.consumeStatus('disposed')) {
        attempts++;
    }
    expect(attempts).toBe(5_891);
    expect(disposed).toMatchObject({ scope: 'disposed', ordinaryRowsSuppressed: true, admissionLimited: true });
    expect(scope.consumeOrdinary()).toBe(false);
    expect(scope.allocate('pc')).toMatchObject({ admitted: false, id: { reason: 'scope-disposed' } });
    expect(scope.dispose()).toBeUndefined();
});

it.each(['absent', 'failed', 'invalid'] as const)('admits finite lifetimes with %s identity source evidence', (failure) => {
    const capability = RtcNativeObservationScope.create(
        failure === 'absent' ? {} : {
            createScopeId: () => {
                if (failure === 'failed') {
                    throw new Error('private-source');
                }
                return 'private-invalid nonce';
            }
        }
    );
    if (capability.status !== 'available') {
        throw new Error('Identity failure must preserve a live scope');
    }
    const admission = capability.scope.allocate('pc');
    expect(admission).toEqual({
        kind: 'pc',
        admitted: true,
        id: { status: 'unavailable', reason: failure === 'invalid' ? 'identity-invalid' : `identity-source-${failure}` }
    });
    expect(capability.scope.consumeTerminal(admission, 'final')).toBe(true);
    expect(JSON.stringify(admission)).not.toContain('private');
});

it('makes no cross-scope uniqueness guarantee for a repeated nonce', () => {
    const first = RtcNativeObservationScope.create({ createScopeId: () => 'same' });
    const second = RtcNativeObservationScope.create({ createScopeId: () => 'same' });
    if (first.status !== 'available' || second.status !== 'available') {
        throw new Error('Expected scopes');
    }
    const admission = first.scope.allocate('pc');
    expect(second.scope.allocate('pc').id).toEqual(admission.id);
    expect(second.scope.consumeTerminal(admission, 'final')).toBe(false);
});

it('charges the actual timestamped serialized source event against the 8192-byte bound', () => {
    const capability = RtcNativeObservationScope.create({ createScopeId: () => 'bounded' });
    if (capability.status !== 'available') {
        throw new Error('Expected scope');
    }
    const events: RtcSignalingDiagnostics.Event[] = [];
    const base: RtcSignalingDiagnostics.NativeObservation = {
        kind: 'native-observation-status',
        stage: 'initialized',
        availability: { status: 'observed', value: 'enabled' },
        capture: capability.scope.getCaptureStatus(),
        localSessionId: '',
        peerSessionId: undefined,
        signalType: undefined,
        offerId: undefined
    };
    const count = 8192 - new TextEncoder().encode(JSON.stringify(base)).length;
    recordRtcNativeObservation({ nativeObservation: capability, nowEpochMs: () => 9999999999999, record: (event) => events.push(event) }, {
        ...base,
        localSessionId: 'x'.repeat(count)
    });
    expect(events.every((event) => new TextEncoder().encode(JSON.stringify(event)).length <= 8192)).toBe(true);
    expect(capability.scope.getCaptureStatus().payloadLimited).toBe(true);
});

it.each(['service', 'peer', 'channel'] as const)('finishes a new scope after nonce-source reentry into the existing %s owner', (owner) => {
    const runtime = installNativeRtcRuntime();
    const oldEvents: RtcSignalingDiagnostics.Event[] = [];
    const oldCapability = RtcNativeObservationScope.create({ createScopeId: () => 'old-scope' });
    const oldService = createObservedService({ nativeObservation: oldCapability, nowEpochMs: () => 1, record: (row) => oldEvents.push(row) });
    const original = oldService.ensurePeerConnectionStarted('z-peer', true).right?.peer;
    if (!original) {
        throw new Error('Expected old graph');
    }
    const oldPc = original.connection.status.pc;
    const oldChannel = original.channel.status.dc;
    let calls = 0;
    const capability = RtcNativeObservationScope.create({
        createScopeId: () => {
            calls++;
            if (owner === 'service') {
                oldService.disconnectPeer('z-peer');
                oldService.ensurePeerConnectionStarted('z-peer', true);
            }
            else if (owner === 'peer') {
                original.connection.reset();
                original.connection.connect();
            }
            else {
                original.channel.reset();
                original.channel.connect(true);
            }
            return 'new-scope';
        }
    });
    const current = oldService.readPeer('z-peer');
    expect(current).toBeDefined();
    if (owner === 'channel') {
        expect(current?.channel.status.dc).not.toBe(oldChannel);
        expect(oldChannel?.readyState).toBe('closed');
    }
    else {
        expect(current?.connection.status.pc).not.toBe(oldPc);
        expect(oldPc?.connectionState).toBe('closed');
    }
    const newEvents: RtcSignalingDiagnostics.Event[] = [];
    const service = createObservedService({ nativeObservation: capability, nowEpochMs: () => 1, record: (row) => newEvents.push(row) });
    const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
    expect(peer?.connection.getNativeIdentity().peerConnectionId).toEqual({ status: 'observed', value: 'new-scope-pc-2' });
    expect(peer?.channel.status.dc).toBeDefined();
    expect(current?.connection.getNativeIdentity().peerConnectionId).toMatchObject({ status: 'observed', value: expect.stringMatching(/^old-scope-/) });
    expect(calls).toBe(1);
    expect(JSON.stringify(oldEvents)).not.toContain('new-scope');
    expect(JSON.stringify(newEvents)).not.toContain('old-scope');
    service.disconnectPeer('z-peer');
    oldService.disconnectPeer('z-peer');
    runtime.dispose();
});

it('preserves a native constructor failure with Native installed and no fabricated created or deleted lifetime', () => {
    const runtime = installNativeRtcRuntime();
    const failure = new Error('original native constructor failure');
    vi.stubGlobal(
        'RTCPeerConnection',
        class {
            constructor() {
                throw failure;
            }
        }
    );
    const events: RtcSignalingDiagnostics.Event[] = [];
    const capability = RtcNativeObservationScope.create({ createScopeId: () => 'constructor-failure' });
    const service = createObservedService({ nativeObservation: capability, nowEpochMs: () => 1, record: (row) => events.push(row) });
    const notifications: string[] = [];
    service.onRtcPeerLifecycleDo('business', {
        onCreated: () => {
            notifications.push('created');
        },
        onDeleted: () => {
            notifications.push('deleted');
        }
    });
    const result = service.ensurePeerConnectionStarted('z-peer', true);
    expect(result.left).toMatchObject({ kind: 'connect-failed', error: failure });
    expect(result.left && 'error' in result.left ? result.left.error : undefined).toBe(failure);
    expect(notifications).toEqual([]);
    expect(service.readPeer('z-peer')).toBeUndefined();
    expect(runtime.createdConnections).toHaveLength(0);
    expect(events.some((row) => row.kind === 'native-lifetime')).toBe(false);
    const terminal = events.find((row) => row.kind === 'service-peer-observation' && row.service.stage === 'terminating');
    expect(terminal).toMatchObject({
        service: {
            issuer: { status: 'observed', value: 'native-start-failure' },
            native: {
                identity: { peerConnectionId: { status: 'unavailable', reason: 'no-native-object' } },
                firstError: { status: 'unavailable', reason: 'no-native-object' }
            }
        }
    });
    expect(toRtcNativeObservationProjection(JSON.parse(JSON.stringify(terminal))).event).toBeDefined();
    service.disposeNativeObservations();
    expect(capability.status === 'available' && capability.scope.getActive()).toBe(false);
    runtime.dispose();
});

it.each(['setup', 'pc', 'channel'] as const)('keeps actual native creation, channel callbacks and sends after %s admission denial', async (kind) => {
    const runtime = installNativeRtcRuntime();
    const capability = RtcNativeObservationScope.create({ createScopeId: () => 'limited' });
    if (capability.status !== 'available') {
        throw new Error('Expected capability');
    }
    for (let index = 0; index < (kind === 'channel' ? 1024 : 256); index++) {
        capability.scope.allocate(kind);
    }
    const events: RtcSignalingDiagnostics.Event[] = [];
    const service = createObservedService({ nativeObservation: capability, nowEpochMs: () => 1, record: (row) => events.push(row) });
    const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
    const native = runtime.createdConnections[0];
    expect(peer?.connection.status.pc).toBe(native);
    expect(peer?.channel.status.dc).toBe(native.channels[0]);
    const callbacks: string[] = [];
    peer?.channel.onRtcCallbacksDo('business', {
        onOpen: async () => {
            callbacks.push('open');
        }
    });
    await native.channels[0].open();
    native.channels[0].send('native-business');
    expect(callbacks).toEqual(['open']);
    expect(native.channels[0].sent).toEqual(['native-business']);
    expect(capability.scope.getCaptureStatus().admissionLimited).toBe(true);
    if (kind === 'pc') {
        expect(peer?.connection.getNativeIdentity().peerConnectionId).toEqual({ status: 'unavailable', reason: 'admission-limit' });
    }
    service.disconnectPeer('z-peer');
    expect(native.connectionState).toBe('closed');
    expect(native.channels[0].readyState).toBe('closed');
    runtime.dispose();
});

it.each(['setup', 'pc-created', 'channel-created', 'timeout', 'reset', 'channel-error'] as const)(
    'contains sink and clock reentry in the %s publication family',
    async (family) => {
        vi.useFakeTimers();
        const runtime = installNativeRtcRuntime();
        for (const effect of ['clock', 'sink'] as const) {
            for (const throws of [false, true]) {
                const events: RtcSignalingDiagnostics.Event[] = [];
                const trace: string[] = [];
                const notifications: string[] = [];
                const effectsNotifications: string[][] = [];
                const capability = RtcNativeObservationScope.create({ createScopeId: () => `${family}-${effect}-${throws}` });
                let armed = false;
                let reentries = 0;
                let original: WebRtcConnectionService.Peer | undefined;
                let originalPc: RTCPeerConnection | undefined;
                const reenter = () => {
                    armed = false;
                    reentries++;
                    original ??= service.readPeer('z-peer');
                    originalPc ??= original?.connection.status.pc;
                    trace.push('effect');
                    effectsNotifications.push([...notifications]);
                    service.disconnectPeer('z-peer');
                    service.ensurePeerConnectionStarted('z-peer', true);
                    if (throws) {
                        throw new Error('diagnostic effect failed');
                    }
                };
                const diagnostics: RtcSignalingDiagnostics = {
                    nativeObservation: capability,
                    nowEpochMs: () => {
                        if (armed && effect === 'clock') {
                            reenter();
                        }
                        return 1;
                    },
                    record: (row) => {
                        events.push(row);
                        const target = family === 'setup'
                            ? row.kind === 'service-peer-observation' && row.service.stage === 'setup-started'
                            : family === 'timeout'
                            ? row.kind === 'service-peer-observation' && row.service.stage === 'establishment-timeout'
                            : family === 'channel-error'
                            ? row.kind === 'native-first-error' && row.error.source === 'channel-error'
                            : row.kind === 'native-lifetime' && (family === 'reset'
                                ? row.action === 'retiring'
                                : row.action === 'created' && row.native.identity.channelId.status === (family === 'pc-created' ? 'unavailable' : 'observed'));
                        if (armed && effect === 'sink' && target) {
                            reenter();
                        }
                    }
                };
                const service = createObservedService(diagnostics, family === 'timeout');
                service.onRtcPeerLifecycleDo('trace', {
                    onCreated: () => {
                        trace.push('created');
                    },
                    onDeleted: () => {
                        trace.push('deleted');
                    }
                });
                trace.push('registered');
                if (family === 'setup' || family === 'pc-created' || family === 'channel-created') {
                    armed = true;
                    service.ensurePeerConnectionStarted('z-peer', true);
                }
                else {
                    const peer = service.ensurePeerConnectionStarted('z-peer', true).right?.peer;
                    if (!peer) {
                        throw new Error('Expected initial peer');
                    }
                    const native = runtime.createdConnections.at(-1);
                    original = peer;
                    originalPc = peer.connection.status.pc;
                    armed = true;
                    if (family === 'timeout') {
                        await vi.advanceTimersByTimeAsync(50);
                    }
                    else if (family === 'reset') {
                        peer.connection.reset();
                    }
                    else {
                        peer.channel.onRtcCallbacksDo('trace', {
                            onError: async () => {
                                notifications.push('error');
                            },
                            onClose: async () => {
                                notifications.push('close');
                            }
                        });
                        await native?.channels[0].fail();
                    }
                }
                expect(reentries).toBe(1);
                if (family === 'channel-error') {
                    expect(effectsNotifications).toEqual([['error', 'close']]);
                }
                expect(trace.indexOf('registered')).toBeLessThan(trace.indexOf('created'));
                expect(trace.indexOf('created')).toBeLessThan(trace.indexOf('effect'));
                const replacement = service.readPeer('z-peer');
                expect(replacement).toBeDefined();
                expect(replacement).not.toBe(original);
                if (originalPc) {
                    expect(originalPc.connectionState).toBe('closed');
                }
                const error = new Event('icecandidateerror');
                Object.defineProperty(error, 'errorCode', { value: 701 });
                replacement?.connection.status.pc?.dispatchEvent(error);
                const identity = replacement?.connection.getNativeIdentity();
                expect(events).toContainEqual(expect.objectContaining({
                    kind: 'native-first-error',
                    native: expect.objectContaining({ identity })
                }));
                service.disconnectPeer('z-peer');
                service.disposeNativeObservations();
                service.disposeNativeObservations();
                const finals = events.filter((row) => row.kind === 'native-lifetime' && row.action === 'retiring')
                    .map((row) => JSON.stringify(row.native.identity));
                expect(new Set(finals).size).toBe(finals.length);
                expect(events.filter((row) => row.kind === 'native-observation-status' && row.stage === 'disposed')).toHaveLength(1);
                expect(capability.status === 'available' && capability.scope.getActive()).toBe(false);
            }
        }
        runtime.dispose();
    }
);

function createObservedService(diagnostics: RtcSignalingDiagnostics, timeoutEnabled = false): WebRtcConnectionService {
    const service = new WebRtcConnectionService({ connect: async () => {}, send: async () => {} }, {
        sessionId: 'a-self',
        token: 'test',
        dataChannelName: 'room',
        rtcSignalingTopicId: 'rtc',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 1000 },
        peerEstablishmentTimeout: { enabled: timeoutEnabled, timeoutMs: 50 }
    }, { createOfferId: () => 'offer', nowEpochMs: () => 1, faultPort: createPassThroughTransportFaultPort(), signalingDiagnostics: diagnostics });
    onTestFinished(() => {
        for (const peerId of service.knownPeerIds()) {
            service.disconnectPeer(peerId);
        }
        service.disposeNativeObservations();
    });
    return service;
}
