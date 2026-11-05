import { describe, expect, it } from 'vitest';

import { newALMulticastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toWsQueueBoxServerRecipientCopy } from '@shared/services/ws-queue-box-server/scope/to-ws-queue-box-server-recipient-copy.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const PROOF = { alg: 'ES256', keyId: 'k'.repeat(43), signature: 's'.repeat(86) } as const;

/** Seq 5 on `a`'s track as `a` signed it, with the record of its own sends. */
function signedFrame(): ALMessage {
    const message = newALMulticastMessage(
        'a',
        newALRoute('room.round.event', ROOM.groupId, 'event-5'),
        ROOM,
        'round.event.v1',
        { msgId: 'event-5' }
    );
    return {
        ...message,
        ordering: { orderingKey: 'game-1', epoch: 1, seq: 5, priorSeqByRecipient: { c: 1 } },
        proof: PROOF
    };
}

describe('the copy the WS server sends one recipient of a recorded track', () => {
    it('carries only the recipient own entry when its prior is below seq - 1, and no proof', () => {
        const copy = toWsQueueBoxServerRecipientCopy({
            message: signedFrame(),
            recipientPeerId: 'c',
            sentPositions: { b: 4, c: 2, d: 0 }
        });

        expect(copy.right?.ordering).toEqual({ orderingKey: 'game-1', epoch: 1, seq: 5, priorSeqByRecipient: { c: 2 } });
        expect(copy.right?.proof).toBeUndefined();
    });

    it('carries an empty record to a recipient last sent seq - 1', () => {
        const copy = toWsQueueBoxServerRecipientCopy({ message: signedFrame(), recipientPeerId: 'b', sentPositions: { b: 4 } });

        expect(copy.right?.ordering?.priorSeqByRecipient).toEqual({});
        expect(copy.right?.proof).toBeUndefined();
    });

    it('carries an empty record to a recipient the read did not record', () => {
        const copy = toWsQueueBoxServerRecipientCopy({ message: signedFrame(), recipientPeerId: 'd', sentPositions: { b: 4 } });

        expect(copy.right?.ordering?.priorSeqByRecipient).toEqual({});
    });

    it('resends a copy to a recipient already at seq: a retry of an unconfirmed copy is not an exclusion', () => {
        const copy = toWsQueueBoxServerRecipientCopy({ message: signedFrame(), recipientPeerId: 'b', sentPositions: { b: 5 } });

        expect(copy.right?.ordering?.priorSeqByRecipient).toEqual({});
    });

    it('skips a recipient whose position a later row of the track already moved past seq', () => {
        const copy = toWsQueueBoxServerRecipientCopy({ message: signedFrame(), recipientPeerId: 'b', sentPositions: { b: 6 } });

        expect(copy.left).toEqual({ kind: 'below-position' });
    });

    it('leaves a copy no dequeue recorded as it is', () => {
        const message = signedFrame();

        expect(toWsQueueBoxServerRecipientCopy({ message, recipientPeerId: 'b', sentPositions: undefined }).right).toBe(message);
    });

    it('leaves an untracked copy as it is', () => {
        const message = { ...signedFrame(), ordering: undefined };

        expect(toWsQueueBoxServerRecipientCopy({ message, recipientPeerId: 'b', sentPositions: { b: 9 } }).right).toBe(message);
    });
});
