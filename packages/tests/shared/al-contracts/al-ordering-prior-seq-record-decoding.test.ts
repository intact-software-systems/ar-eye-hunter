import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };

const ORDERED: ALMessage = newALBroadcastMessage(
    'server',
    newALRoute('room.app.event', 'room-1', 'game-1:2'),
    'room',
    'app.event.v1',
    {},
    { groupRef: ROOM, ordering: { orderingKey: 'game-1', epoch: 2, seq: 5 } }
);

function withPriorSeqs(priorSeqByRecipient: unknown): unknown {
    return { ...ORDERED, ordering: { ...ORDERED.ordering, priorSeqByRecipient } };
}

describe('the prior sequences an authority recorded on an ordered copy', () => {
    it('decodes a record of recipients to the last sequence previously sent them, 0 for none', () => {
        const message = withPriorSeqs({ 'session-b': 0, 'session-c': 3 });

        expect(decodeALMessageValue(message).right).toEqual(message);
    });

    it('decodes an empty record: every recipient was last sent the previous sequence', () => {
        expect(decodeALMessageValue(withPriorSeqs({})).right).toEqual(withPriorSeqs({}));
    });

    it.each([
        { label: 'a fractional sequence', record: { 'session-b': 1.5 } },
        { label: 'a negative sequence', record: { 'session-b': -1 } },
        { label: 'a sequence past the safe integers', record: { 'session-b': Number.MAX_SAFE_INTEGER + 1 } },
        { label: 'a string sequence', record: { 'session-b': '3' } },
        { label: 'an empty recipient', record: { '': 3 } },
        { label: 'an array', record: [3] },
        { label: 'a number', record: 3 },
        { label: 'null', record: null }
    ])('refuses $label as malformed', ({ record }) => {
        expect(decodeALMessageValue(withPriorSeqs(record)).left).toMatchObject({ code: 'malformed' });
    });

    it('refuses a record past the collection limit before any field decodes', () => {
        const record = Object.fromEntries(
            Array.from({ length: AL_MESSAGE_RESOURCE_LIMITS.collectionEntries + 1 }, (_, index) => [`session-${index}`, 0])
        );

        expect(decodeALMessageValue(withPriorSeqs(record)).left).toMatchObject({ code: 'oversized' });
    });
});
