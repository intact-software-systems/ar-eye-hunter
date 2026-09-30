import {
    decodeRtcSignalingRoute,
    validateRtcSignalingMessage
} from '@shared-server/rallar-system/communication/decode-rtc-signaling-route.ts';
import {
    newALEventRoute,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

const ICE_PAYLOAD = { description: null, candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 9 typ host', sdpMid: '0' } };

describe('RTC signaling route authority', () => {
    it('routes an offer from its authenticated origin to its bound recipient', () => {
        const message = createSignal({});
        expect(decodeRtcSignalingRoute(message).right).toEqual({ toId: 'receiver' });
        expect(validateRtcSignalingMessage(message).right).toBe(message);
    });

    it('routes an ICE candidate, which names no offer', () => {
        const message = createSignal({ signalType: 'IceCandidate', offerId: undefined, payload: ICE_PAYLOAD });
        expect(validateRtcSignalingMessage(message).right).toBe(message);
    });

    it.each([
        { fromId: 'victim' },
        { toId: 'another-recipient' }
    ])('rejects a signaling identity that differs from its AL envelope: %j', (replacement) => {
        expect(validateRtcSignalingMessage(createSignal(replacement)).left?.code).toBe('unauthorized');
    });

    it.each([
        { unexpected: true },
        { channel: 'OldRtcSignal' },
        { toId: undefined },
        { offerId: undefined },
        { offerId: null },
        { offerId: '' },
        { offerId: '   ' },
        { offerId: 17 },
        { signalType: 'Renegotiate' },
        { payload: { description: { type: 'offer', sdp: 'sdp', extra: true }, candidate: null } },
        { payload: { description: { type: 'offer', sdp: 'sdp' }, candidate: null, extra: true } },
        { payload: { description: { type: 'answer', sdp: 'sdp' }, candidate: null } },
        { signalType: 'IceCandidate', payload: ICE_PAYLOAD }
    ])('rejects a malformed signaling value: %j', (replacement) => {
        expect(validateRtcSignalingMessage(createSignal(replacement)).left?.code).toBe('malformed');
    });
});

function createSignal(replacement: Readonly<Record<string, unknown>>): ALMessage {
    return newALUnicastMessage('sender', newALEventRoute('rtc', 'receiver'), 'receiver', 'rtc', {
        channel: 'RtcSignal',
        type: 'Signal',
        fromId: 'sender',
        toId: 'receiver',
        sessionId: 'sender',
        token: 'ticket',
        signalType: 'Offer',
        offerId: 'offer-1',
        payload: { description: { type: 'offer', sdp: 'sdp' }, candidate: null },
        ...replacement
    });
}
