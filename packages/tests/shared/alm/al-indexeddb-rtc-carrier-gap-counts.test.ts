import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_OUTBOUND_DEQUEUE_WAIT_RECHECK_MS } from '@shared/alm/outbound/lane/read-al-outbound-dequeue-wait.ts';
import { createCountingIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createOriginOverlay,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_ROOM,
    type RtcOriginOverlayFixture
} from '../multicast/rtc-origin-overlay-fixture.ts';
import { createIndexedDbOriginStores } from './create-indexed-db-origin-stores.ts';

const NAMESPACE = 'rtc-carrier-gap';
const HELD_RECHECKS = 40;

describe('an RTC origin holding a durable send through a carrier gap', () => {
    it(
        're-checks the gap 40 times on one claim with one not-ready attempt and no IndexedDB operation',
        async () => {
            const observer = createCountingIndexedDbOperationObserver();
            const fixture = createRtcOriginOverlayFixture({
                snapshot: createOriginSnapshot(['a', 'b'], 4),
                nextHopPeerIds: ['b'],
                stores: createIndexedDbOriginStores(observer, NAMESPACE)
            });
            fixture.overlays.delete('room');
            const message = createDurableRoomMulticast();

            expect((await fixture.manager.enqueueLegIfAbsent(message, 'hold')).verdict.kind).toBe(
                'admitted'
            );
            await vi.waitFor(() => expect(readAttemptOutcomes(fixture, message)).toEqual(['not-ready']));
            const held = structuredClone(observer.getCounts());
            await new Promise((resolve) => setTimeout(resolve, HELD_RECHECKS * AL_OUTBOUND_DEQUEUE_WAIT_RECHECK_MS));
            const afterRechecks = structuredClone(observer.getCounts());

            expect(readAttemptOutcomes(fixture, message)).toEqual(['not-ready']);
            // Before the hold, each 50 ms wait released and reclaimed the row: 5 al-work operations a wait.
            expect(afterRechecks).toEqual(held);
            expect(fixture.channels.b!.sent).toEqual([]);

            fixture.overlays.accept('room', createOriginOverlay(['b']));
            await vi.waitFor(() =>
                expect(fixture.channels.b!.sent.map((sent) => sent.id.msgId)).toEqual([
                    message.id.msgId
                ])
            );
            expect(readAttemptOutcomes(fixture, message)).toEqual(['not-ready', 'sent']);
        },
        15_000
    );
});

function createDurableRoomMulticast(): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'chat', resourceId: 'held-counted', contextId: 'room' },
        ORIGIN_ROOM,
        'chat.message.v1',
        { text: 'held' },
        {
            ack: 'all-logical-recipients',
            reliability: 'at-least-once',
            ttlMs: 30_000,
            qos: { durability: { algo: 'local-outbox' } }
        }
    );
}

function readAttemptOutcomes(
    fixture: RtcOriginOverlayFixture,
    message: ALMessage
): readonly string[] {
    return fixture.settlements.flatMap((settlement) =>
        settlement.kind === 'attempt-settled' && settlement.msgId === message.id.msgId
            ? [settlement.outcome]
            : []
    );
}
