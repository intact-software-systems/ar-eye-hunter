import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';

import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain
} from './rtc-origin-overlay-fixture.ts';
import { createRtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';

const ACK_TIMEOUT_MS = 2_000;

describe('the child hops an RTC relay owns', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('lets both recipients of a three-session star deliver and ACK, relaying nothing to each other', async () => {
        const snapshot = createOriginSnapshot(['a', 'b', 'c'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c'] });
        const b = createRtcRelayOverlayFixture({ selfPeerId: 'b', snapshot, neighbourPeerIds: ['a', 'c'] });
        const c = createRtcRelayOverlayFixture({ selfPeerId: 'c', snapshot, neighbourPeerIds: ['a', 'b'] });
        const message = createOriginReceiverMulticast('star');
        await enqueueAndDrain(origin.manager, message);

        await b.receive(origin.channels.b!.sent[0]!, 'a');
        await c.receive(origin.channels.c!.sent[0]!, 'a');

        // In a star the origin already addresses both recipients, so neither owns the other as a child.
        expect(readCopies(await b.readSent('c'), message)).toBe(0);
        expect(readCopies(await c.readSent('b'), message)).toBe(0);
        const acks = [...await b.readSent('a'), ...await c.readSent('a')];
        expect(readAckTuples(acks)).toEqual([['b', 'delivered'], ['c', 'delivered']]);
        for (const ack of acks) {
            await origin.manager.acceptControlMessage(ack);
        }
        expect(await origin.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toBeUndefined();
        expect(origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1))
            .toMatchObject({ mode: 'receiver', complete: true, unconfirmedHopPeerIds: [] });

        await vi.advanceTimersByTimeAsync(10 * ACK_TIMEOUT_MS);

        expect(origin.channels.b!.sent).toHaveLength(1);
        expect(origin.channels.c!.sent).toHaveLength(1);
    });

    it('never owns a sibling its sender addressed, even when the mesh also lists it as a neighbour', async () => {
        const snapshot = createOriginSnapshot(['a', 'b', 'c', 'd'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c'] });
        const b = createRtcRelayOverlayFixture({ selfPeerId: 'b', snapshot, neighbourPeerIds: ['a', 'c', 'd'] });
        const message = createOriginReceiverMulticast('mesh');
        await enqueueAndDrain(origin.manager, message);

        await b.receive(origin.channels.b!.sent[0]!, 'a');

        expect(readCopies(await b.readSent('c'), message)).toBe(0);
        expect(readCopies(await b.readSent('d'), message)).toBe(1);
    });
});

function readCopies(messages: readonly ALMessage[], message: ALMessage): number {
    return messages.filter((sent) => sent.id.msgId === message.id.msgId).length;
}

function readAckTuples(messages: readonly ALMessage[]): readonly (readonly [string, string])[] {
    return messages.flatMap((message) => {
        const control = parseALControlMessage(message);
        return control?.type === 'ack' ? [[control.payload.logicalRecipientPeerId, control.payload.status] as const] : [];
    });
}
