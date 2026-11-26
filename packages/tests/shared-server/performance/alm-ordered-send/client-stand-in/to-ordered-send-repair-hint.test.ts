import { describe, expect, it } from 'vitest';

import type { ALNackPayload, ALPeerRepairControlMessage, ALRepairPayload } from '@shared/al-contracts/al-control.ts';

import type { OrderedSendSentMessage } from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/client-stand-in/compute-ordered-send-repair-reoffers.ts';
import { toOrderedSendRepairHint } from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/client-stand-in/to-ordered-send-repair-hint.ts';

const SERVER = 'default-qbox-server';
const PUBLISHER = 'session-01-a';
const TRACK = '["ordered-send-cell","default","room-1"]:session-01-a:0';

/** The publisher has offered the sends 1 to 4 of its track. */
const SENT_MESSAGES: readonly OrderedSendSentMessage[] = [1, 2, 3, 4].map((seq) => ({
    msgId: `${PUBLISHER}-send-${seq}`,
    trackKey: TRACK,
    seq,
    maxRepairs: 4,
    repairAttempts: 0
}));

/** The server's gap NACK about send 4, whose arrival showed that 3 is missing. */
function toGapNack(overrides: Partial<ALNackPayload>): ALPeerRepairControlMessage {
    return {
        type: 'nack',
        payload: {
            msgId: `${PUBLISHER}-send-4`,
            fromPeerId: SERVER,
            toPeerId: PUBLISHER,
            logicalRecipientPeerId: SERVER,
            originPeerId: PUBLISHER,
            reason: 'gap',
            observedAtEpochMs: 1_800_000_000_100,
            orderingKey: TRACK,
            expectedSeq: 3,
            missingRanges: [{ from: 3, to: 3 }],
            gapRequestNumber: 1,
            relayHopsLeft: 0,
            proof: null,
            ...overrides
        }
    };
}

function toRepairRequest(overrides: Partial<ALRepairPayload>): ALPeerRepairControlMessage {
    return {
        type: 'repair',
        payload: {
            msgId: `${PUBLISHER}-send-4`,
            fromPeerId: SERVER,
            toPeerId: PUBLISHER,
            reason: 'missing-seq',
            observedAtEpochMs: 1_800_000_000_100,
            orderingKey: TRACK,
            expectedSeq: 3,
            missingRanges: [{ from: 3, to: 3 }],
            gapRequestNumber: 1,
            ...overrides
        }
    };
}

function readHint(control: ALPeerRepairControlMessage, readerPeerId: string) {
    return toOrderedSendRepairHint({ control, readerPeerId, sentMessages: SENT_MESSAGES });
}

describe('toOrderedSendRepairHint', () => {
    it('raises one hint for the gap NACK and the repair request the server sends of one gap', () => {
        const hintOfTheGap = {
            trigger: 'nack',
            requestedByPeerId: SERVER,
            orderingTrackKey: TRACK,
            missingRanges: [{ from: 3, to: 3 }],
            gapRequestNumber: 1,
            failedPeerIds: []
        };

        expect(readHint(toGapNack({}), PUBLISHER)).toEqual(hintOfTheGap);
        expect(readHint(toRepairRequest({}), PUBLISHER)).toEqual(hintOfTheGap);
    });

    it('raises a hint that names no range for a repair request that asks for the send itself', () => {
        const request = toRepairRequest({
            reason: 'retransmit',
            orderingKey: undefined,
            expectedSeq: undefined,
            missingRanges: undefined,
            gapRequestNumber: undefined
        });

        expect(readHint(request, PUBLISHER)).toEqual({
            trigger: 'repair',
            requestedByPeerId: SERVER,
            missingRanges: [],
            failedPeerIds: []
        });
    });

    it.each([
        ['a NACK of another reason than a gap', toGapNack({ reason: 'expired' }), PUBLISHER],
        ['a request addressed to another session', toGapNack({ toPeerId: 'session-02-b' }), PUBLISHER],
        ['a request another session read', toRepairRequest({}), 'session-02-b'],
        ['a NACK that names another origin', toGapNack({ originPeerId: 'session-02-b' }), PUBLISHER],
        ['a request about a send its reader never offered', toRepairRequest({ msgId: `${PUBLISHER}-send-9` }), PUBLISHER],
        ['a request on another track than its send\'s', toGapNack({ orderingKey: `${TRACK}-other` }), PUBLISHER],
        ['a range that reaches the send that showed the gap', toGapNack({ missingRanges: [{ from: 3, to: 4 }] }), PUBLISHER],
        ['a range below the sequence the server expects', toGapNack({ missingRanges: [{ from: 2, to: 3 }] }), PUBLISHER],
        ['an expected sequence past the send that showed the gap', toRepairRequest({ expectedSeq: 5 }), PUBLISHER]
    ])('raises none for %s', (_name, control, readerPeerId) => {
        expect(readHint(control, readerPeerId)).toBeUndefined();
    });
});
