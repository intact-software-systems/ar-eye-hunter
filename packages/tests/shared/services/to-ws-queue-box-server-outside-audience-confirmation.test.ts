import { describe, expect, it } from 'vitest';

import type { ALNackPayload } from '@shared/al-contracts/al-control.ts';
import {
    isWsQueueBoxServerOwnOutsideAudienceNack,
    toWsQueueBoxServerOutsideAudienceConfirmation
} from '@shared/services/ws-queue-box-server/receipt/to-ws-queue-box-server-outside-audience-confirmation.ts';

const SERVER = 'server';

function nack(overrides: Partial<ALNackPayload>): ALNackPayload {
    return {
        msgId: 'delta-1',
        fromPeerId: 'b',
        toPeerId: SERVER,
        logicalRecipientPeerId: 'b',
        originPeerId: SERVER,
        reason: 'before-entry',
        observedAtEpochMs: 1_800_000_000_000,
        proof: null,
        ...overrides
    };
}

describe('an outside-audience NACK of a server publication', () => {
    it('is a NACK about the server\'s own publication, addressed to it, for an outside-audience reason', () => {
        // Pins another origin's NACK, or one that asks a repair, being written as an outside recipient of the server's.
        expect([
            isWsQueueBoxServerOwnOutsideAudienceNack(nack({}), SERVER),
            isWsQueueBoxServerOwnOutsideAudienceNack(nack({ reason: 'not-subscribed' }), SERVER),
            isWsQueueBoxServerOwnOutsideAudienceNack(nack({ originPeerId: 'origin' }), SERVER),
            isWsQueueBoxServerOwnOutsideAudienceNack(nack({ toPeerId: 'relay' }), SERVER),
            isWsQueueBoxServerOwnOutsideAudienceNack(nack({ reason: 'resync-required' }), SERVER)
        ]).toEqual([true, true, false, false, false]);
    });

    it('is the record\'s outside confirmation of the recipient it names', () => {
        // Pins the NACK's sender, not its logical recipient, being recorded outside.
        expect(toWsQueueBoxServerOutsideAudienceConfirmation(nack({ fromPeerId: 'relay' }))).toEqual({
            originPeerId: SERVER,
            msgId: 'delta-1',
            recipientPeerId: 'b',
            kind: 'outside'
        });
    });
});
