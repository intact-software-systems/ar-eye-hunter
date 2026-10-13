import type { RallarRoomTransportStatus, RallarRtcLifecycleEvent } from '@shared-web/browser/rallar-rtc-facade.ts';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import {
    createHealthyRecordingPeer,
    createHealthyRecordingRtcStatus,
    createHealthyRecordingWsStatus,
    createNativeRecordingEvents,
    createRecordingFormationStatus
} from './recording-policy-fixtures.ts';

import {
    createBlackBoxRallarRuntime,
    type BlackBoxRallarRuntime,
    type BlackBoxRallarRuntimeInstallationTarget
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import { BlackBoxRallarVolatileLimits } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts';
import { installSpaBrowserRallarEventBridge } from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import type { RallarBlackBoxBrowserRallarEvent, RallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { facade, resetFacade } from './browser-rallar-runtime-test-harness.ts';

beforeEach(resetFacade);
afterEach(() => vi.unstubAllGlobals());

interface ConnectedRecorder {
    readonly recorder: RallarBlackBoxBrowserTestRuntime;
    readonly published: RallarBlackBoxBrowserRallarEvent[];
    readonly page: BlackBoxRallarRuntime;
}

async function connectRecorder(mode: 'enabled' | 'disabled', roomId?: string): Promise<ConnectedRecorder> {
    const recorder = createDefaultRallarBlackBoxBrowserTestRuntime({ routineBrowserDiagnostics: mode });
    const published: RallarBlackBoxBrowserRallarEvent[] = [];
    const target: BlackBoxRallarRuntimeInstallationTarget = {};
    vi.stubGlobal('window', target);
    const restore = installSpaBrowserRallarEventBridge({
        receiveRallarBrowserEvent: (event) => {
            published.push(event);
            recorder.receiveRallarBrowserEvent(event);
        }
    });
    const page = createBlackBoxRallarRuntime({
        facade: facade.rallar,
        volatileLimits: new BlackBoxRallarVolatileLimits(),
        targetWindow: target,
        clock: { now: Date.now },
        readDocument: () => ({ timeOrigin: 100, origin: 'https://runtime.example.test' }),
        delay: async () => undefined
    });
    onTestFinished(async () => {
        await page.close();
        restore();
    });
    await page.connect({
        connection: 'observer-a',
        roomId,
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            username: 'alice',
            password: 'secret',
            almDiagnostics: true
        }
    });
    return { recorder, published, page };
}

const signalIdentity = { localSessionId: 'session-a', peerSessionId: 'session-c', signalType: 'Offer', offerId: 'offer-c', atEpochMs: 100 } as const;
const nativeIdentity: RtcSignalingDiagnostics.NativeIdentity = {
    peerConnectionId: { status: 'unavailable', reason: 'disabled' },
    channelId: { status: 'unavailable', reason: 'disabled' }
};
const ordinarySignals: readonly RtcSignalingDiagnostics.Event[] = [
    { ...signalIdentity, kind: 'service-signal-route', disposition: 'policy-allow', result: undefined },
    {
        ...signalIdentity,
        kind: 'native-signal-decision',
        disposition: 'remote-description-returned',
        nativeIdentity,
        capturedPeerConnection: true,
        currentPeerConnection: true,
        offerMatches: undefined,
        signalingState: undefined
    },
    {
        ...signalIdentity,
        kind: 'signal-caller-release',
        disposition: 'application-returned',
        nativeIdentity,
        capturedPeerConnection: true,
        currentPeerConnection: true
    }
];

it.each(['enabled', 'disabled'] as const)('records signaling with %s routine policy and preserves rejected or retired observations', async (mode) => {
    const { recorder, published } = await connectRecorder(mode);
    const signaling = facade.records.defaultWrites.at(-1)?.diagnosticsPorts?.signalingDiagnostics;
    expect(signaling).toBeTypeOf('function');
    const retained: readonly RtcSignalingDiagnostics.Event[] = [
        { ...signalIdentity, kind: 'service-signal-route', disposition: 'accepted-peer-result', result: 'signal-handle-failed' },
        { ...signalIdentity, kind: 'service-signal-route', disposition: 'policy-retry', result: undefined },
        {
            ...signalIdentity,
            kind: 'signal-caller-release',
            disposition: 'application-threw',
            nativeIdentity,
            capturedPeerConnection: true,
            currentPeerConnection: true
        },
        {
            ...signalIdentity,
            kind: 'signal-caller-release',
            disposition: 'application-returned',
            nativeIdentity,
            capturedPeerConnection: true,
            currentPeerConnection: false
        }
    ];
    for (const event of [...ordinarySignals, ...retained]) {
        signaling?.(event);
    }
    const rows = recorder.state().events.filter((event) => event.topic === 'rallar.browser.rtc.signaling_diagnostics');
    expect(rows.map((event) => event.payload)).toEqual(
        JSON.parse(JSON.stringify(mode === 'enabled' ? [...ordinarySignals, ...retained] : retained)).map((data: object) => expect.objectContaining({ data }))
    );
    expect(published.filter((event) => event.topic === 'rallar.browser.rtc.signaling_diagnostics' && event.routineBrowserDiagnostic).length).toBe(3);
    expect((await recorder.execute({ kind: 'health' })).value).toMatchObject({
        browserDiagnostics: {
            omittedRoutineBrowserDiagnostics: mode === 'disabled' ? 4 : 0
        },
        stats: { rallar: { connected: true } }
    });
});

it.each(['enabled', 'disabled'] as const)('uses A’s installed lifecycle subscriptions with %s recording while C changes', async (mode) => {
    const { recorder } = await connectRecorder(mode);
    const rtc = facade.behavior.rtcOnLifecycle.mock.calls.at(-1)?.[0];
    const ws = facade.behavior.wsOnLifecycle.mock.calls.at(-1)?.[0];
    const status = createHealthyRecordingRtcStatus();
    const peer = status.peers[0];
    const healthy: readonly RallarRtcLifecycleEvent[] = [
        { kind: 'peer-created', atEpochMs: 101, status, peerId: peer.peerId, peer },
        { kind: 'peer-established', atEpochMs: 102, status, peerId: peer.peerId, peer },
        { kind: 'lane-open', atEpochMs: 103, status, peerId: peer.peerId, peer, laneId: 'realtime', lane: peer.lanes[0] }
    ];
    const failedPeer = createHealthyRecordingPeer('session-d');
    const unsafe: readonly RallarRtcLifecycleEvent[] = [
        { ...healthy[0], status: createHealthyRecordingRtcStatus([peer, { ...failedPeer, connection: { ...failedPeer.connection, state: 'Failed' } }]) },
        {
            ...healthy[0],
            status: createHealthyRecordingRtcStatus([{
                ...peer,
                connection: { ...peer.connection, signaling: { ...peer.connection.signaling, inboundSignalingErrorCount: 1 } }
            }])
        },
        { ...healthy[0], peer: { ...peer, connection: { ...peer.connection, connectionState: 'future-state' } } },
        { ...healthy[2], lane: { ...peer.lanes[0], channel: { ...peer.lanes[0].channel!, counters: { ...peer.lanes[0].channel!.counters, dropped: 1 } } } },
        Object.assign({}, healthy[0], { extra: { status: 'failed' } }),
        ...(['peer-deleted', 'peer-timeout', 'lane-close', 'lane-error', 'signaling-failed'] as const).map((kind) => ({ ...healthy[0], kind }))
    ];
    const before = recorder.state().events.length;
    for (const event of [...healthy, ...unsafe]) {
        await rtc?.(event);
    }
    await ws?.({ kind: 'open', atEpochMs: 104, status: createHealthyRecordingWsStatus(), eventType: 'open' });
    await ws?.({ kind: 'close', atEpochMs: 105, status: createHealthyRecordingWsStatus(), code: 1000, wasClean: true });
    const rows = recorder.state().events.slice(before);
    expect(rows.length).toBe(mode === 'disabled' ? unsafe.length + 1 : healthy.length + unsafe.length + 2);
    expect(rows.slice(0, mode === 'disabled' ? unsafe.length : healthy.length + unsafe.length).map((row) => row.payload))
        .toEqual(JSON.parse(JSON.stringify(mode === 'disabled' ? unsafe : [...healthy, ...unsafe])).map((data: object) => expect.objectContaining({ data })));
    expect((await recorder.execute({ kind: 'health' })).value).toMatchObject({
        browserDiagnostics: {
            omittedRoutineBrowserDiagnostics: mode === 'disabled' ? 5 : 0
        },
        stats: { rallar: { connected: true } }
    });
});

it.each(['enabled', 'disabled'] as const)('certifies only accepted healthy formation observations under %s recording', async (mode) => {
    const status = createRecordingFormationStatus();
    const rtc = createHealthyRecordingRtcStatus();
    const room: RallarRoomTransportStatus = {
        roomRef: status.roomRef,
        roomId: status.roomRef.groupId,
        ws: createHealthyRecordingWsStatus(),
        rtc: {
            desired: true,
            mode: 'eager',
            state: 'open',
            acceptedLayoutIdentity: status.accepted!.identity,
            desiredPeerIds: ['session-c'],
            knownPeerIds: ['session-c'],
            activePeerIds: ['session-c'],
            readyPeerIds: ['session-c'],
            failedPeerIds: [],
            peers: rtc.peers,
            laneId: 'realtime'
        }
    };
    const handle = facade.behavior.roomFormation(status.roomRef);
    facade.behavior.roomFormation.mockReturnValue({ ...handle, roomRef: status.roomRef, status: () => status });
    facade.behavior.rtcRoomStatus.mockReturnValue(room);
    const { recorder, published } = await connectRecorder(mode, status.roomRef.groupId);
    const notify = facade.behavior.rtcOnStatus.mock.calls.at(-1)?.[0];
    expect(notify).toBeTypeOf('function');
    const before = recorder.state().events.length;
    await notify?.(rtc);
    facade.behavior.rtcRoomStatus.mockReturnValue({
        ...room,
        rtc: {
            ...room.rtc,
            state: 'connecting',
            readyPeerIds: [],
            activePeerIds: ['session-c'],
            peers: [{
                ...rtc.peers[0],
                isActive: true,
                isRoutable: false,
                readyLaneIds: [],
                lanes: [],
                connection: { ...rtc.peers[0].connection, state: 'Connecting', connectionState: 'connecting' }
            }]
        }
    });
    await notify?.(rtc);
    for (const state of ['partial', 'degraded', 'failed', 'idle', 'halted'] as const) {
        facade.behavior.rtcRoomStatus.mockReturnValue({ ...room, rtc: { ...room.rtc, state } });
        await notify?.(rtc);
    }
    for (
        const patch of [
            { readyPeerIds: ['wrong-peer'] },
            { desiredPeerIds: [], readyPeerIds: [] },
            { reason: 'terminal wait' },
            { acceptedLayoutIdentity: { ...status.accepted!.identity, version: 9 } },
            { peers: [{ ...rtc.peers[0], connection: { ...rtc.peers[0].connection, connectionState: 'failed' } }] }
        ]
    ) {
        facade.behavior.rtcRoomStatus.mockReturnValue({ ...room, rtc: { ...room.rtc, ...patch } });
        await notify?.(rtc);
    }
    facade.behavior.rtcRoomStatus.mockReturnValue({ ...room, roomRef: { ...status.roomRef, groupId: 'other' } });
    await notify?.(rtc);
    facade.behavior.rtcRoomStatus.mockReturnValue(room);
    for (
        const patch of [
            { formationAttemptCount: 1 },
            { dialing: 'none' as const },
            { memberPolicy: Object.assign({}, status.memberPolicy, { transports: 'ws-only' as const }) },
            { accepted: Object.assign({}, status.accepted, { overlay: null }) },
            { planned: Object.assign({}, status.accepted, { role: 'planned' as const }) },
            { transportState: 'halted' as const },
            { lastFormationOutcome: { outcome: 'below-floor' as const, observedRate: 0, atEpochMs: 1, formationEpoch: 0 } }
        ]
    ) {
        facade.behavior.roomFormation.mockReturnValue({ ...handle, status: () => ({ ...status, ...patch }) });
        await notify?.(rtc);
    }
    const rows = recorder.state().events.slice(before).filter((event) => event.topic === 'rallar.browser.formation.room-status');
    expect(rows).toHaveLength(mode === 'disabled' ? 18 : 20);
    expect(published.filter((event) => event.topic === 'rallar.browser.formation.room-status' && event.routineBrowserDiagnostic)).toHaveLength(2);
    expect((await recorder.execute({ kind: 'health' })).value).toMatchObject({
        browserDiagnostics: {
            omittedRoutineBrowserDiagnostics: mode === 'disabled' ? 3 : 0
        }
    });
});

it('retains unsupported signaling details at both the producer and marked recorder boundary', async () => {
    const { recorder, published } = await connectRecorder('disabled');
    const signaling = facade.records.defaultWrites.at(-1)?.diagnosticsPorts?.signalingDiagnostics;
    const unsafe = [
        Object.assign({}, ordinarySignals[0], { disposition: 'future-disposition' }),
        Object.assign({}, ordinarySignals[0], { disposition: ['policy-allow'] }),
        Object.assign({}, ordinarySignals[0], { signalType: ['Offer'] }),
        Object.assign({}, ordinarySignals[0], { disposition: 'accepted-peer-result', result: ['setup-started'] }),
        Object.assign({}, ordinarySignals[0], { result: { nested: { status: 'failed' } } }),
        Object.assign({}, ordinarySignals[0], { peerSessionId: null }),
        Object.assign({}, ordinarySignals[0], { offerId: undefined }),
        Object.assign({}, ordinarySignals[1], { nativeIdentity: { ...nativeIdentity, peerConnectionId: { status: 'unavailable', reason: 'read-failed' } } }),
        Object.assign({}, ordinarySignals[1], { extra: { failure: 'native' } }),
        Object.assign({}, ordinarySignals[2], { capturedPeerConnection: false }),
        Object.assign({}, ordinarySignals[2], { kind: 'future-kind' })
    ];
    for (const event of unsafe) {
        signaling?.(event);
    }
    const rows = recorder.state().events.filter((event) => event.topic === 'rallar.browser.rtc.signaling_diagnostics');
    expect(rows.map((row) => row.payload)).toEqual(JSON.parse(JSON.stringify(unsafe)).map((data: object) => expect.objectContaining({ data })));
    expect(
        published.filter((event) => event.topic === 'rallar.browser.rtc.signaling_diagnostics').every((event) => event.routineBrowserDiagnostic === undefined)
    ).toBe(true);
    for (const data of [...unsafe, null, { snapshot: { status: 'failed' } }]) {
        recorder.receiveRallarBrowserEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.rtc.signaling_diagnostics',
            data,
            routineBrowserDiagnostic: true,
            severity: 'info'
        });
    }
    expect(recorder.state().events.filter((event) => event.topic === 'rallar.browser.rtc.signaling_diagnostics')).toHaveLength(24);
    expect((await recorder.execute({ kind: 'health' })).value).toMatchObject({ browserDiagnostics: { omittedRoutineBrowserDiagnostics: 1 } });
});

it('retains every native evidence family through the live diagnostics port when routine recording is disabled', async () => {
    const { recorder, published } = await connectRecorder('disabled');
    const signaling = facade.records.defaultWrites.at(-1)?.diagnosticsPorts?.signalingDiagnostics;
    const events = createNativeRecordingEvents();
    for (const event of events) {
        signaling?.(event);
    }
    const rows = recorder.state().events.filter((event) => event.topic === 'rallar.browser.rtc.signaling_diagnostics');
    expect(rows.map((row) => row.payload)).toEqual(JSON.parse(JSON.stringify(events)).map((data: object) => expect.objectContaining({ data })));
    expect(rows).toHaveLength(8);
    expect(published.filter((event) => event.topic === 'rallar.browser.rtc.signaling_diagnostics').every((event) => !event.routineBrowserDiagnostic)).toBe(
        true
    );
    expect((await recorder.execute({ kind: 'health' })).value).toMatchObject({ browserDiagnostics: { omittedRoutineBrowserDiagnostics: 1 } });
});

it('retains contradictory and malformed RTC snapshots even when the event kind signals successful progress', async () => {
    const { recorder } = await connectRecorder('disabled');
    const notify = facade.behavior.rtcOnLifecycle.mock.calls.at(-1)?.[0];
    const peer = createHealthyRecordingPeer();
    const status = createHealthyRecordingRtcStatus([peer]);
    const base = { kind: 'peer-established', atEpochMs: 110, status, peerId: peer.peerId, peer } as const;
    const malformedPeer = { ...peer, connection: { ...peer.connection, hasRemoteDescription: false } };
    const inconsistent: readonly RallarRtcLifecycleEvent[] = [
        { ...base, status: createHealthyRecordingRtcStatus([malformedPeer]), peer: malformedPeer },
        { ...base, peer: { ...peer, connection: Object.assign({}, peer.connection, { outbound: { status: 'failed' } }) } },
        {
            ...base,
            peer: {
                ...peer,
                connection: { ...peer.connection, state: 'Connecting', connectionState: 'connecting' },
                isActive: false,
                isRoutable: false,
                readyLaneIds: [],
                lanes: []
            }
        },
        { ...base, peer: { ...peer, connection: { ...peer.connection, signaling: { ...peer.connection.signaling, outboundOfferCount: 0.5 } } } },
        { ...base, status: { ...status, readyPeerIds: ['wrong-peer'] } },
        { ...base, status: createHealthyRecordingRtcStatus([{ ...peer, isRoutable: false }]) },
        {
            ...base,
            peer: {
                ...peer,
                connection: { ...peer.connection, state: 'Connecting', connectionState: 'connecting' },
                isRoutable: false,
                readyLaneIds: [],
                lanes: []
            },
            kind: 'peer-created'
        },
        { ...base, kind: 'lane-open', laneId: 'realtime', lane: { ...peer.lanes[0], channel: { ...peer.lanes[0].channel!, role: 'unknown' } } }
    ];
    const before = recorder.state().events.length;
    for (const event of inconsistent) {
        await notify?.(event);
    }
    expect(recorder.state().events.slice(before).map((row) => row.payload)).toEqual(
        JSON.parse(JSON.stringify(inconsistent)).map((data: object) => expect.objectContaining({ data }))
    );
});
