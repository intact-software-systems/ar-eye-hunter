import { describe, expect, it } from 'vitest';

import { isInstanceLocalRtcSignal } from '@shared-server/rallar-system/communication/is-instance-local-rtc-signal.ts';
import { newALEventRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';

/** The live notice limit less the reserve its wrapper may take. */
const MAX_BYTES = 8_000 - 1_024;

describe('isInstanceLocalRtcSignal', () => {
    it('keeps a relay-only signal whose envelope fits, measured in UTF-8 bytes', () => {
        expect(isInstanceLocalRtcSignal(signalOfBytes(MAX_BYTES, 'a'))).toBe(true);
        expect(isInstanceLocalRtcSignal(signalOfBytes(MAX_BYTES + 1, 'a'))).toBe(false);
    });

    it('measures multi-byte content by its encoded length, not its code units', () => {
        // 'é' is one UTF-16 code unit and two UTF-8 bytes: within the limit by length, over it by bytes.
        const signal = signalOfBytes(MAX_BYTES + 2, 'é');

        expect(JSON.stringify(signal).length).toBeLessThanOrEqual(MAX_BYTES);
        expect(isInstanceLocalRtcSignal(signal)).toBe(false);
        expect(isInstanceLocalRtcSignal(signalOfBytes(MAX_BYTES, 'é'))).toBe(true);
    });

    it('sends an acknowledged signal and any other topic to the shared store', () => {
        const acknowledged: ALMessage = {
            ...signalOfBytes(1_000, 'a'),
            delivery: { reliability: 'at-least-once', ack: 'receiver' }
        };
        const other = newALUnicastMessage('sender', newALEventRoute('app.notes', 'receiver', 'note'), 'receiver', 'notes.v1', {});

        expect(isInstanceLocalRtcSignal(acknowledged)).toBe(false);
        expect(isInstanceLocalRtcSignal(other)).toBe(false);
    });
});

/** A signal whose serialized envelope is `bytes` UTF-8 bytes long, padded with `filler`. */
function signalOfBytes(bytes: number, filler: 'a' | 'é'): ALMessage {
    const padding = bytes - utf8Length(JSON.stringify(signal('')));
    const fillers = Math.floor(padding / utf8Length(filler));
    return signal(filler.repeat(fillers) + 'a'.repeat(padding - fillers * utf8Length(filler)));
}

function utf8Length(text: string): number {
    return new TextEncoder().encode(text).length;
}

function signal(sdp: string): ALMessage {
    return newALUnicastMessage(
        'sender',
        newALEventRoute(AppTopics.rtcSignaling, 'receiver', 'offer'),
        'receiver',
        AppTopics.rtcSignaling,
        {
            channel: 'RtcSignal',
            type: 'Signal',
            fromId: 'sender',
            toId: 'receiver',
            sessionId: 'sender',
            token: 'fixture-ticket',
            signalType: 'Offer',
            offerId: 'offer-1',
            payload: { description: { type: 'offer', sdp }, candidate: null }
        }
    );
}
