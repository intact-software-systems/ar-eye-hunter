import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { computeALOrderingObservation } from '@shared/alm/compute-al-ordering-observation.ts';
import { acceptALSupersedenceObservation } from '@shared/alm/compute-al-supersedence-observation.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

describe('AL admission policy transitions', () => {
    it('reports only the newly contiguous sequence while peeking buffered releases', () => {
        const observation = computeALOrderingObservation({
            snapshot: {
                lastContiguousSeq: 0,
                bufferedSeqs: [2],
                updatedAtMs: 1_000
            },
            msg: createOrderedMessage(1),
            nowMs: 1_001,
            trackTtlMs: 60_000,
            apply: false
        });

        expect(observation).toMatchObject({
            observation: {
                status: 'in-order',
                seq: 1,
                expectedSeq: 2,
                lastContiguousSeq: 1,
                releasableSeqs: [2]
            },
            nextSnapshot: {
                lastContiguousSeq: 0,
                bufferedSeqs: [2]
            }
        });
    });

    it('retains both replacement writes when the latest and explicit replacement are the same message', () => {
        const acceptance = acceptALSupersedenceObservation({
            supersedence: {
                key: 'presence:room-1',
                msgId: 'msg-2',
                replacesMsgId: 'msg-1',
                seq: 2,
                ts: 2_000
            },
            latest: {
                kind: 'latest',
                latestMsgId: 'msg-1',
                latestSeq: 1,
                latestTs: 1_000,
                updatedAtMs: 1_000
            },
            replacement: undefined,
            nowMs: 2_000,
            trackTtlMs: 60_000
        });

        expect(acceptance.replacementWrites).toEqual([
            {
                msgId: 'msg-1',
                value: { kind: 'replacement', byMsgId: 'msg-2', updatedAtMs: 2_000 }
            },
            {
                msgId: 'msg-1',
                value: { kind: 'replacement', byMsgId: 'msg-2', updatedAtMs: 2_000 }
            }
        ]);
    });
});

function createOrderedMessage(seq: number) {
    return {
        ...newALUnicastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: `msg-${seq}`,
                contextId: 'conversation-1'
            },
            'peer-2',
            'chat.private-text.v1',
            { text: `message-${seq}` }
        ),
        ordering: {
            orderingKey: 'conversation-1',
            epoch: 0,
            seq
        }
    };
}
