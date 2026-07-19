import { describe, expect, it } from 'vitest';
import {
    type ALMessage,
    newALEventRoute,
    newALUnicastMessage,
} from '@shared/al-contracts/al-contract.ts';
import {
    QRtcSignalingChannel,
    type QRtcSignalingMessage,
    QRtcSignalingMsgType,
    QRtcSignalingType,
} from '@shared/webrtc/QRtcSignalingContracts.ts';
import {
    traceRtcSignalingMessage,
    withRtcSignalingServerForwardedTiming,
    withRtcSignalingServerReceivedTiming,
} from '@shared/webrtc/RtcSignalingTrace.ts';

describe('RTC signaling trace', () => {
    it('preserves relay timing and emits a payload-free correlated event', () => {
        const message = createRtcSignalingEnvelope();
        const received = withRtcSignalingServerReceivedTiming(message, 1_020);
        const forwarded = withRtcSignalingServerForwardedTiming(received, 1_025);
        const traced = traceRtcSignalingMessage(
            forwarded,
            'client-inbox-received',
            1_040,
        );

        expect(traced.message.diagnostics?.wsRelayTiming).toEqual({
            receivedAtEpochMs: 1_020,
            forwardedAtEpochMs: 1_025,
        });
        expect(traced.event).toMatchObject({
            schemaVersion: 1,
            stage: 'client-inbox-received',
            messageId: 'rtc-message-1',
            messageCreatedAtEpochMs: 1_000,
            atEpochMs: 1_040,
            signalType: QRtcSignalingType.Offer,
            fromId: 'sender',
            toId: 'target',
            elapsedMs: 40,
            serverReceivedAtEpochMs: 1_020,
            serverForwardedAtEpochMs: 1_025,
        });

        const serialized = JSON.stringify(traced.event);
        expect(serialized).not.toContain('payload');
        expect(serialized).not.toContain('resource');
        expect(serialized).not.toContain('sdp-secret');
        expect(serialized).not.toContain('candidate-secret');
    });

    it('leaves non-RTC messages unchanged and emits no event', () => {
        const message = newALUnicastMessage(
            'sender',
            newALEventRoute('chat', 'target', 'chat-message-1'),
            'target',
            'chat',
            { text: 'hello' },
        );

        const received = withRtcSignalingServerReceivedTiming(message, 1_020);
        const forwarded = withRtcSignalingServerForwardedTiming(message, 1_025);
        const traced = traceRtcSignalingMessage(
            message,
            'client-inbox-received',
            1_040,
        );

        expect(received).toBe(message);
        expect(forwarded).toBe(message);
        expect(traced.message).toBe(message);
        expect(traced.event).toBeUndefined();
    });
});

function createRtcSignalingEnvelope(): ALMessage {
    const signal: QRtcSignalingMessage = {
        channel: QRtcSignalingChannel.RtcSignal,
        type: QRtcSignalingMsgType.Signal,
        fromId: 'sender',
        toId: 'target',
        sessionId: 'sender',
        token: 'NOT_CREATED_YET',
        signalType: QRtcSignalingType.Offer,
        payload: {
            description: {
                type: 'offer',
                sdp: 'sdp-secret',
            },
            candidate: {
                candidate: 'candidate-secret',
                sdpMid: '0',
                sdpMLineIndex: 0,
                usernameFragment: 'secret-fragment',
            },
        },
    };
    const message = newALUnicastMessage(
        'sender',
        newALEventRoute('rtc', 'target', 'rtc-resource-1'),
        'target',
        'rtc',
        signal,
    );

    return {
        ...message,
        id: {
            ...message.id,
            msgId: 'rtc-message-1',
            ts: 1_000,
        },
    };
}
