import { describe, expect, it } from 'vitest';

import { decodeRtcSignalingRoute } from '@shared-server/rallar-system/communication/decode-rtc-signaling-route.ts';

describe('decodeRtcSignalingRoute', () => {
    it('returns the recipient from the current signaling envelope', () => {
        expect(decodeRtcSignalingRoute(JSON.stringify({
            channel: 'RtcSignal',
            type: 'Signal',
            fromId: 'session-1',
            toId: 'session-2',
            sessionId: 'session-1',
            token: 'ticket-1',
            signalType: 'Offer',
            payload: {
                description: { type: 'offer', sdp: 'offer-sdp' },
                candidate: null
            }
        }))).toEqual({ toId: 'session-2' });
    });

    it.each([
        ['unknown field', { unexpected: true }],
        ['wrong channel', { channel: 'OldRtcSignal' }],
        ['missing recipient', { toId: undefined }],
        ['unsupported signal type', { signalType: 'Renegotiate' }]
    ])('rejects a signaling envelope with an %s', (_label, replacement) => {
        const message = {
            channel: 'RtcSignal',
            type: 'Signal',
            fromId: 'session-1',
            toId: 'session-2',
            sessionId: 'session-1',
            token: 'ticket-1',
            signalType: 'Offer',
            payload: {
                description: { type: 'offer', sdp: 'offer-sdp' },
                candidate: null
            },
            ...replacement
        };
        let serialized = JSON.stringify(message);
        if (Object.hasOwn(replacement, 'toId') && replacement.toId === undefined) {
            const { toId: _missingRecipient, ...withoutRecipient } = message;
            serialized = JSON.stringify(withoutRecipient);
        }

        expectInvalidRtcSignalingRoute(serialized);
    });
});

function expectInvalidRtcSignalingRoute(serialized: string): void {
    expect(() => decodeRtcSignalingRoute(serialized)).toThrow(TypeError);
}
