import {
    describe,
    expect,
    it
} from 'vitest';

import { decodeRtcSignal } from '@shared/webrtc/decode-rtc-signaling-message.ts';

describe('decodeRtcSignal', () => {
    it('names the offer generation an answer must not carry', () => {
        expect(() =>
            decodeRtcSignal({
                signalType: 'Answer',
                offerId: 'offer-1',
                offerGeneration: 1,
                payload: { description: { type: 'answer', sdp: 'answer-sdp' }, candidate: null }
            })
        ).toThrow('Unexpected RTC answer offer generation');
    });

    it('names the offer identity an ICE candidate must not carry', () => {
        expect(() =>
            decodeRtcSignal({
                signalType: 'IceCandidate',
                offerGeneration: 1,
                payload: { description: null, candidate: { candidate: 'candidate:1' } }
            })
        ).toThrow('Unexpected RTC ICE offer identity');
    });
});
