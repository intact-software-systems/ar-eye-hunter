import { describe, expect, it } from 'vitest';

import { RtcNativeChannelAttachments } from '@shared-test/black-box-runner/artifacts/rtc-native-channel-attachments.ts';
import { toRtcNativeObservationProjection } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { createNativeAcquisitionSnapshotFixture } from './rtc-native-acquisition-fixture.ts';

describe('current native channel attachments', () => {
    it('preserves an open channel across later peer-connection-only snapshots', () => {
        const channels = createChannelAttachments();
        const open = createStateEvent(createSnapshot('channel-a', 'open', 1));
        channels.observe(open);
        channels.observe(createStateEvent(createSnapshot(undefined, 'open', 2)));

        expect(channels.getCurrentChannel()).toEqual(open);
    });

    it('orders each channel by its own sequence while allowing a later nonterminal open', () => {
        const channels = createChannelAttachments();
        const olderOpen = createStateEvent(createSnapshot('channel-a', 'open', 2));
        channels.observe(createStateEvent(createSnapshot('channel-a', 'connecting', 3)));
        channels.observe(olderOpen);
        expect(channels.getCurrentChannel()).toBeUndefined();

        const currentOpen = createStateEvent(createSnapshot('channel-a', 'open', 4));
        channels.observe(createStateEvent(createSnapshot(undefined, 'open', 5)));
        channels.observe(currentOpen);
        expect(channels.getCurrentChannel()).toEqual(currentOpen);
    });

    it('keeps separate channel lifetimes within one peer connection', () => {
        const channels = createChannelAttachments();
        const first = createStateEvent(createSnapshot('channel-a', 'open', 1));
        channels.observe(first);
        channels.observe(createStateEvent(createSnapshot('channel-b', 'open', 2)));
        channels.observe(createStateEvent(createSnapshot('channel-b', 'closed', 3)));
        expect(channels.getCurrentChannel()).toEqual(first);

        channels.observe(createStateEvent(createSnapshot('channel-a', 'closed', 4)));
        expect(channels.getCurrentChannel()).toBeUndefined();
    });

    it.each(['closing', 'closed', 'retiring'] as const)('does not resurrect a channel after %s', (terminal) => {
        const channels = createChannelAttachments();
        channels.observe(createStateEvent(createSnapshot('channel-a', 'open', 1)));
        const native = createSnapshot('channel-a', terminal === 'retiring' ? 'open' : terminal, 2);
        channels.observe(terminal === 'retiring' ? createRetirementEvent(native) : createStateEvent(native));
        expect(channels.getCurrentChannel()).toBeUndefined();

        channels.observe(createStateEvent(createSnapshot('channel-a', 'open', 3)));
        expect(channels.getCurrentChannel()).toBeUndefined();
    });

    it.each(['closed', 'retiring', 'terminating'] as const)('invalidates every child after parent %s', (terminal) => {
        const channels = createChannelAttachments();
        channels.observe(createStateEvent(createSnapshot('channel-a', 'open', 1)));
        channels.observe(createStateEvent(createSnapshot('channel-b', 'open', 2)));
        const snapshot = createSnapshot(undefined, 'open', 3);
        if (terminal === 'closed') {
            channels.observe(createStateEvent({ ...snapshot, state: { ...snapshot.state, connectionState: { status: 'observed', value: 'closed' } } }));
        }
        else {
            channels.observe(terminal === 'retiring' ? createRetirementEvent(snapshot) : createServiceEvent(snapshot, 'terminating'));
        }
        expect(channels.getCurrentChannel()).toBeUndefined();

        channels.observe(createStateEvent(createSnapshot('channel-a', 'open', 4)));
        channels.observe(createStateEvent(createSnapshot('channel-c', 'open', 5)));
        expect(channels.getCurrentChannel()).toBeUndefined();
    });

    it('isolates peer connections, including parent termination and channel IDs', () => {
        const channels = createChannelAttachments();
        const open = createStateEvent(createSnapshot('channel-a', 'open', 1));
        channels.observe(open);
        const other = createSnapshot('channel-a', 'open', 2);
        const otherPeer: RtcSignalingDiagnostics.NativeSnapshot = {
            ...other,
            identity: { ...other.identity, peerConnectionId: { status: 'observed', value: 'pc-b' } }
        };
        channels.observe(createStateEvent(otherPeer));
        channels.observe(
            createRetirementEvent({
                ...otherPeer,
                nativeSequence: 3,
                identity: { ...otherPeer.identity, channelId: { status: 'unavailable', reason: 'not-applicable' } }
            })
        );
        expect(channels.getCurrentChannel()).toEqual(open);
    });

    it.each(['disconnected', 'connecting', 'failed'] as const)('does not infer terminal lifetime from connection state %s', (connectionState) => {
        const channels = createChannelAttachments();
        const open = createStateEvent(createSnapshot('channel-a', 'open', 1));
        channels.observe(open);
        const snapshot = createSnapshot(undefined, 'open', 2);
        channels.observe(createStateEvent({
            ...snapshot,
            state: {
                ...snapshot.state,
                connectionState: { status: 'observed', value: connectionState },
                iceConnectionState: { status: 'observed', value: 'disconnected' }
            }
        }));
        expect(channels.getCurrentChannel()).toEqual(open);
    });

    it.each(['localSessionId', 'peerSessionId', 'scopeId'] as const)('ignores another %s', (field) => {
        const channels = createChannelAttachments();
        const open = createStateEvent(createSnapshot('channel-a', 'open', 1));
        channels.observe(open);
        const snapshot = createSnapshot(undefined, 'open', 2);
        const terminal = createRetirementEvent(
            field === 'scopeId' ? { ...snapshot, capture: { ...snapshot.capture, scopeId: { status: 'observed', value: 'other-scope' } } } : snapshot
        );
        channels.observe(field === 'scopeId' ? terminal : { ...terminal, [field]: 'other-session' });
        expect(channels.getCurrentChannel()).toEqual(open);
    });

    it('uses explicit compact channel closure without treating a truncated inventory as absence', () => {
        const channels = createChannelAttachments();
        const open = createStateEvent(createSnapshot('channel-a', 'open', 1));
        channels.observe(open);
        channels.observe(createServiceEvent(createSnapshot(undefined, 'open', 2), 'setup-established'));
        expect(channels.getCurrentChannel()).toEqual(open);

        const closed = createSnapshot('channel-a', 'closed', 3);
        channels.observe(
            createServiceEvent(createSnapshot(undefined, 'open', 3), 'setup-established', [{
                identity: closed.identity,
                channelState: closed.state.channelState
            }])
        );
        expect(channels.getCurrentChannel()).toBeUndefined();
        channels.observe(open);
        expect(channels.getCurrentChannel()).toBeUndefined();
    });

    it('does not create full attachment proof from a compact service channel', () => {
        const channels = createChannelAttachments();
        const open = createSnapshot('channel-a', 'open', 1);
        channels.observe(
            createServiceEvent(createSnapshot(undefined, 'open', 1), 'setup-established', [{ identity: open.identity, channelState: open.state.channelState }])
        );
        expect(channels.getCurrentChannel()).toBeUndefined();
    });
});

function createChannelAttachments(): RtcNativeChannelAttachments {
    return new RtcNativeChannelAttachments({ localSessionId: 'session-a', peerSessionId: 'session-b', scopeId: { status: 'observed', value: 'scope-a' } });
}

function createSnapshot(
    channelId: string | undefined,
    channelState: RTCDataChannelState,
    sequence: number
): RtcSignalingDiagnostics.NativeSnapshot {
    const snapshot = createNativeAcquisitionSnapshotFixture({
        scopeId: { status: 'observed', value: 'scope-a' },
        scope: 'active',
        ordinaryRowsSuppressed: false,
        admissionLimited: false,
        payloadLimited: false
    });
    return {
        ...snapshot,
        nativeSequence: sequence,
        identity: {
            peerConnectionId: { status: 'observed', value: 'pc-a' },
            channelId: channelId === undefined ? { status: 'unavailable', reason: 'not-applicable' } : { status: 'observed', value: channelId }
        },
        state: {
            ...snapshot.state,
            connectionState: { status: 'observed', value: 'connected' },
            channelState: channelId === undefined ? { status: 'unavailable', reason: 'not-applicable' } : { status: 'observed', value: channelState }
        }
    };
}

function createStateEvent(native: RtcSignalingDiagnostics.NativeSnapshot): ApiJsonObject {
    return projectEvent({
        kind: 'native-state',
        trigger: 'connection',
        localSessionId: 'session-a',
        peerSessionId: 'session-b',
        atEpochMs: native.nativeSequence,
        native
    });
}

function createRetirementEvent(native: RtcSignalingDiagnostics.NativeSnapshot): ApiJsonObject {
    return projectEvent({
        kind: 'native-lifetime',
        action: 'retiring',
        retirement: 'reset',
        localSessionId: 'session-a',
        peerSessionId: 'session-b',
        atEpochMs: native.nativeSequence,
        native
    });
}

function createServiceEvent(
    native: RtcSignalingDiagnostics.NativeSnapshot,
    stage: 'setup-established' | 'terminating',
    channels: readonly RtcSignalingDiagnostics.CompactChannel[] = []
): ApiJsonObject {
    return projectEvent({
        kind: 'service-peer-observation',
        localSessionId: 'session-a',
        peerSessionId: 'session-b',
        atEpochMs: native.nativeSequence,
        service: {
            stage,
            peerId: 'session-b',
            setupId: { status: 'observed', value: 'setup-a' },
            setup: { peerId: 'session-b', phase: 'established', startedAtEpochMs: 1, establishedAtEpochMs: 2 },
            issuer: stage === 'terminating' ? { status: 'observed', value: 'disconnect-peer' } : { status: 'unavailable', reason: 'not-applicable' },
            timeout: { status: 'unavailable', reason: 'not-applicable' },
            native,
            capture: native.capture,
            channels,
            channelCount: channels.length + 1,
            channelsTruncated: true
        }
    });
}

function projectEvent(value: unknown): ApiJsonObject {
    const event = toRtcNativeObservationProjection(value).event;
    if (!event) {
        throw new Error('Native channel fixture did not satisfy the canonical projection.');
    }
    return event;
}
