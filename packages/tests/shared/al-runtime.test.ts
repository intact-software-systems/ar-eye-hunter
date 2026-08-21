import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryALDedupStore, InMemoryALOrderingStore, InMemoryALSupersedenceStore } from '@shared/al-contracts/al-runtime.ts';
import { describe, expect, it } from 'vitest';

describe('AL runtime stores', () => {
    it('expires dedup keys once their ttl elapses', async () => {
        const store = new InMemoryALDedupStore();

        await store.mark('msg-1', 50, 1_000);

        expect(store.has('msg-1', 1_049)).toBe(true);
        expect(await store.deleteExpired(1_049)).toBe(0);
        expect(await store.deleteExpired(1_050)).toBe(1);
        expect(store.has('msg-1', 1_050)).toBe(false);
    });

    it('buffers ordered gaps and releases buffered messages when the missing sequence arrives', async () => {
        const store = new InMemoryALOrderingStore();
        const seq2 = createOrderedMessage(2);
        const seq1 = createOrderedMessage(1);

        await expect(store.accept(seq2, 2_000)).resolves.toMatchObject({
            status: 'gap',
            expectedSeq: 1,
            missingSeqs: [1],
            releasableSeqs: []
        });

        expect(store.peek(seq1, 2_001)).toMatchObject({
            status: 'in-order',
            expectedSeq: 1,
            releasableSeqs: [2]
        });

        await expect(store.accept(seq1, 2_001)).resolves.toMatchObject({
            status: 'in-order',
            lastContiguousSeq: 2,
            releasableSeqs: [2]
        });

        expect(store.peek(seq2, 2_002).status).toBe('duplicate');
    });

    it('drops expired ordering tracks', async () => {
        const store = new InMemoryALOrderingStore(10);

        await store.accept(createOrderedMessage(1), 3_000);

        expect(await store.deleteExpired(3_009)).toBe(0);
        expect(await store.deleteExpired(3_010)).toBe(1);
        expect(store.peek(createOrderedMessage(1), 3_010).status).toBe('in-order');
    });

    it('tracks superseding messages and marks replaced messages as superseded', async () => {
        const store = new InMemoryALSupersedenceStore();

        await expect(
            store.accept(
                {
                    key: 'presence:room-1',
                    msgId: 'msg-1',
                    seq: 1,
                    ts: 4_000
                },
                4_000
            )
        ).resolves.toMatchObject({
            status: 'current',
            latestMsgId: 'msg-1'
        });

        expect(
            store.peek(
                {
                    key: 'presence:room-1',
                    msgId: 'msg-0',
                    seq: 0,
                    ts: 3_999
                },
                4_001
            )
        ).toMatchObject({
            status: 'superseded',
            latestMsgId: 'msg-1'
        });

        expect(
            store.peek(
                {
                    key: 'presence:room-1',
                    msgId: 'msg-2',
                    replacesMsgId: 'msg-1',
                    seq: 2,
                    ts: 4_002
                },
                4_002
            ).status
        ).toBe('replaces-current');

        await expect(
            store.accept(
                {
                    key: 'presence:room-1',
                    msgId: 'msg-2',
                    replacesMsgId: 'msg-1',
                    seq: 2,
                    ts: 4_002
                },
                4_002
            )
        ).resolves.toMatchObject({
            status: 'current',
            latestMsgId: 'msg-2'
        });

        expect(
            store.peek(
                {
                    key: 'presence:room-1',
                    msgId: 'msg-1',
                    seq: 1,
                    ts: 4_000
                },
                4_003
            )
        ).toMatchObject({
            status: 'superseded',
            latestMsgId: 'msg-2'
        });
    });

    it('expires supersedence state for both current and replacement lookups', async () => {
        const store = new InMemoryALSupersedenceStore(10);

        await store.accept(
            {
                key: 'presence:room-2',
                msgId: 'msg-3',
                seq: 1,
                ts: 5_000
            },
            5_000
        );
        await store.accept(
            {
                key: 'presence:room-2',
                msgId: 'msg-4',
                replacesMsgId: 'msg-3',
                seq: 2,
                ts: 5_001
            },
            5_001
        );

        expect(await store.deleteExpired(5_010)).toBe(0);
        expect(await store.deleteExpired(5_011)).toBe(2);
        expect(
            store.peek(
                {
                    key: 'presence:room-2',
                    msgId: 'msg-3',
                    seq: 1,
                    ts: 5_000
                },
                5_011
            ).status
        ).toBe('current');
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
            {
                text: `message-${seq}`
            }
        ),
        ordering: {
            orderingKey: 'conversation-1',
            epoch: 0,
            seq
        }
    };
}
