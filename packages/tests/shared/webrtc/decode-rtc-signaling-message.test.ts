import {
    describe,
    expect,
    it
} from 'vitest';

import { decodeRtcSignal } from '@shared/webrtc/decode-rtc-signaling-message.ts';

describe('decodeRtcSignal', () => {
    it.each([
        { signalType: 'Offer', offerId: 'offer-1', payload: { description: { type: 'offer', sdp: 'offer-sdp' }, candidate: null } },
        { signalType: 'Answer', offerId: 'offer-1', payload: { description: { type: 'answer', sdp: 'answer-sdp' }, candidate: null } },
        { signalType: 'IceCandidate', payload: { description: null, candidate: { candidate: 'candidate:1' } } }
    ])('requires the sending connection generation on a $signalType', (signal) => {
        expect(() => decodeRtcSignal(signal)).toThrow('Invalid RTC connection generation');
        expect(decodeRtcSignal({ ...signal, connectionGeneration: 4 })).toEqual({ ...signal, connectionGeneration: 4 });
    });

    it('names the offer identity an ICE candidate must not carry', () => {
        expect(() =>
            decodeRtcSignal({
                signalType: 'IceCandidate',
                offerId: 'offer-1',
                connectionGeneration: 1,
                payload: { description: null, candidate: { candidate: 'candidate:1' } }
            })
        ).toThrow('Unexpected RTC ICE offer identity');
    });
});
