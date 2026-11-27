import { describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';

import { toTestALNackPayload } from '../../../../al-control-test-payloads.ts';
import type { SimulatedWebSocket } from '../../../../shared/native-websocket-fixture.ts';
import { readOriginReceipts, receiverAck, roomMessage } from '../../../../shared/services/ws-queue-box-server-receipt-fixture.ts';
import {
    advanceLiveRoomClock,
    connectLiveRoomSession,
    createLiveRoomClusterFixture,
    readDataCopies,
    readDeliveryWorkStatuses,
    settleLiveRoomCluster,
    type LiveRoomClusterFixture,
    type LiveRoomInstance
} from './live-room-cluster-fixture.ts';

const ORIGIN = 'p';
const ROOM = [ORIGIN, 'r1', 'r2'];
const LIFETIME_MS = 10_000;
/** The default receipt policy's ACK timeout; three of them are the default retry count's windows. */
const ACK_TIMEOUT_MS = 2_000;
const KEEPS_ALL = () => false;

describe('a room send on an undeclared topic, live-only across two instances', () => {
    // Pins the fixture: two instances, each a recipient's, one receipt counted in the record both share.
    it('delivers a receipted send to a recipient on each instance once and completes its receipt', async () => {
        const fixture = await createLiveRoomClusterFixture({ roomSessionIds: ROOM, volatileInbound: false });
        const { a, b } = fixture.instances;
        const origin = await connectLiveRoomSession(a, ORIGIN, KEEPS_ALL);
        const r1 = await connectLiveRoomSession(a, 'r1', KEEPS_ALL);
        const r2 = await connectLiveRoomSession(b, 'r2', KEEPS_ALL);

        await offerAndConfirm(fixture, { sends: [receipted(fixture, 'm-1')], confirmations: [[a, 'r1', 'm-1'], [b, 'r2', 'm-1']] });

        expect([readDataCopies(r1), readDataCopies(r2)]).toEqual([['m-1'], ['m-1']]);
        expect(readReceiptLines(origin, 'm-1')).toEqual(['admitted:', 'complete:r1,r2']);
        expect(fixture.bus.notices).toHaveLength(1);
    });

    // P1. Turned by ruling M1 (option 1), slice 2: the server sends a receipted message again to each recipient that
    // has not confirmed it. Pins today's single write: a copy lost at the socket is never sent again.
    it('does not yet send a copy again that a recipient\'s socket lost', async () => {
        const fixture = await createLiveRoomClusterFixture({ roomSessionIds: ROOM, volatileInbound: false });
        const { a, b } = fixture.instances;
        const origin = await connectLiveRoomSession(a, ORIGIN, KEEPS_ALL);
        await connectLiveRoomSession(a, 'r1', KEEPS_ALL);
        const r2 = await connectLiveRoomSession(b, 'r2', (frame) => frame.id.msgId === 'm-2');
        await offerAndConfirm(fixture, {
            sends: [receipted(fixture, 'm-1'), receipted(fixture, 'm-2')],
            confirmations: [[a, 'r1', 'm-1'], [a, 'r1', 'm-2'], [b, 'r2', 'm-1']]
        });

        await advanceLiveRoomClock(fixture, 3 * ACK_TIMEOUT_MS);
        expect(readDataCopies(r2)).toEqual(['m-1']);
        expect(fixture.bus.notices).toHaveLength(2);

        await advanceLiveRoomClock(fixture, LIFETIME_MS);
        expect(readReceiptLines(origin, 'm-2')).toEqual(['admitted:', 'timed-out:r1']);
    });

    // P2. Turned by ruling M1 (option 1), slice 2. Pins today's loss of a notice the recipient's instance never
    // received: nothing sends the copy to that instance's sessions again.
    it('does not yet send a copy again whose notice the recipient\'s instance never received', async () => {
        const fixture = await createLiveRoomClusterFixture({ roomSessionIds: ROOM, volatileInbound: false });
        const { a } = fixture.instances;
        const origin = await connectLiveRoomSession(a, ORIGIN, KEEPS_ALL);
        await connectLiveRoomSession(a, 'r1', KEEPS_ALL);
        const r2 = await connectLiveRoomSession(fixture.instances.b, 'r2', KEEPS_ALL);
        fixture.bus.withholdFrom('b');
        await offerAndConfirm(fixture, { sends: [receipted(fixture, 'm-1')], confirmations: [[a, 'r1', 'm-1']] });
        fixture.bus.deliverToAll();

        await advanceLiveRoomClock(fixture, 3 * ACK_TIMEOUT_MS);
        expect(readDataCopies(r2)).toEqual([]);

        await advanceLiveRoomClock(fixture, LIFETIME_MS);
        expect(readReceiptLines(origin, 'm-1')).toEqual(['admitted:', 'timed-out:r1']);
    });

    // P3. Turned by ruling M1 (option 1), slice 2: the resend reaches a recipient wherever it is then connected. Pins
    // today's miss of a session of the admitted audience whose socket opens just after the hand-off.
    it('does not yet send a copy to a session of the audience whose socket opens after the hand-off', async () => {
        const fixture = await createLiveRoomClusterFixture({ roomSessionIds: [...ROOM, 'r3'], volatileInbound: false });
        const { a, b } = fixture.instances;
        await connectLiveRoomSession(a, ORIGIN, KEEPS_ALL);
        await connectLiveRoomSession(a, 'r1', KEEPS_ALL);
        await connectLiveRoomSession(b, 'r2', KEEPS_ALL);
        await offerAndConfirm(fixture, { sends: [receipted(fixture, 'm-1')], confirmations: [[a, 'r1', 'm-1'], [b, 'r2', 'm-1']] });

        const r3 = await connectLiveRoomSession(b, 'r3', KEEPS_ALL);
        await advanceLiveRoomClock(fixture, LIFETIME_MS - 1);

        expect(readDataCopies(r3)).toEqual([]);
    });

    // P5. No ruling turns it: M1 chose the server's own schedule, not the origin's second offer (design 5.3). Pins the
    // second offer of a receipted send answered from the record, with nothing published again.
    it('answers the origin\'s second offer from the receipt and publishes nothing', async () => {
        const fixture = await createLiveRoomClusterFixture({ roomSessionIds: ROOM, volatileInbound: false });
        const { a, b } = fixture.instances;
        const origin = await connectLiveRoomSession(a, ORIGIN, KEEPS_ALL);
        await connectLiveRoomSession(a, 'r1', KEEPS_ALL);
        const r2 = await connectLiveRoomSession(b, 'r2', (frame) => frame.id.msgId === 'm-2');
        const lost = receipted(fixture, 'm-2');
        await offerAndConfirm(fixture, { sends: [receipted(fixture, 'm-1'), lost], confirmations: [[a, 'r1', 'm-2']] });

        expect((await a.service.acceptIncomingMessage(lost, ORIGIN)).right).toEqual({ kind: 'duplicate' });
        await settleLiveRoomCluster(fixture);

        expect(fixture.bus.notices).toHaveLength(2);
        expect(readDataCopies(r2)).toEqual(['m-1']);
        expect(readReceiptLines(origin, 'm-2')).toEqual(['admitted:', 'admitted:r1']);
    });

    // P4, receipted. Turned by rulings M1 and M7 (option 1), slices 2 and 3: a send whose NOTIFY failed is published
    // again. Pins today's completed delivery work with no copy written anywhere.
    it('completes the delivery work of a receipted send whose publication failed and writes no copy', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const fixture = await createLiveRoomClusterFixture({ roomSessionIds: ROOM, volatileInbound: false });
        const { a, b } = fixture.instances;
        const origin = await connectLiveRoomSession(a, ORIGIN, KEEPS_ALL);
        const r1 = await connectLiveRoomSession(a, 'r1', KEEPS_ALL);
        const r2 = await connectLiveRoomSession(b, 'r2', KEEPS_ALL);
        fixture.bus.failNextPublish();

        await offerAndConfirm(fixture, { sends: [receipted(fixture, 'm-1')], confirmations: [] });
        await advanceLiveRoomClock(fixture, ACK_TIMEOUT_MS);

        expect([readDataCopies(r1), readDataCopies(r2)]).toEqual([[], []]);
        expect([...a.handledMsgIds, ...b.handledMsgIds]).toEqual(['m-1']);
        expect(await readDeliveryWorkStatuses(fixture)).toEqual(['COMPLETED']);
        expect(errors.mock.calls).toEqual([[PUBLICATION_FAILED_LINE]]);
        await advanceLiveRoomClock(fixture, LIFETIME_MS);
        expect(readReceiptLines(origin, 'm-1')).toEqual(['admitted:', 'timed-out:']);
    });

    // P4, unreceipted. Turned by ruling M7 (option 1), slice 3: an at-least-once send whose NOTIFY failed is
    // published again, receipted or not. Pins today's loss, which no receipt reports.
    it('completes the delivery work of an unreceipted send whose publication failed and writes no copy', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const fixture = await createLiveRoomClusterFixture({ roomSessionIds: ROOM, volatileInbound: false });
        const { a, b } = fixture.instances;
        const origin = await connectLiveRoomSession(a, ORIGIN, KEEPS_ALL);
        const r1 = await connectLiveRoomSession(a, 'r1', KEEPS_ALL);
        const r2 = await connectLiveRoomSession(b, 'r2', KEEPS_ALL);
        fixture.bus.failNextPublish();

        await offerAndConfirm(fixture, { sends: [unreceipted(fixture, 'm-1')], confirmations: [] });
        await advanceLiveRoomClock(fixture, ACK_TIMEOUT_MS);

        expect([readDataCopies(r1), readDataCopies(r2)]).toEqual([[], []]);
        expect([...a.handledMsgIds, ...b.handledMsgIds]).toEqual(['m-1']);
        expect(await readDeliveryWorkStatuses(fixture)).toEqual(['COMPLETED']);
        expect(errors.mock.calls).toEqual([[PUBLICATION_FAILED_LINE]]);
        await advanceLiveRoomClock(fixture, LIFETIME_MS);
        expect([readDataCopies(r1), readDataCopies(r2)]).toEqual([[], []]);
        expect(readReceiptLines(origin, 'm-1')).toEqual([]);
    });

    // P6. No ruling turns it: ruling M8 (option 1) keeps hop order on an undeclared topic a stated limit. Pins the
    // refusal of a recipient's gap NACK for a live-path message, which has no outbound row to repair from.
    it('refuses a recipient\'s gap NACK for a hop-ordered send on a default topic', async () => {
        const fixture = await createLiveRoomClusterFixture({ roomSessionIds: ROOM, volatileInbound: false });
        const { a, b } = fixture.instances;
        await connectLiveRoomSession(a, ORIGIN, KEEPS_ALL);
        await connectLiveRoomSession(a, 'r1', KEEPS_ALL);
        const r2 = await connectLiveRoomSession(b, 'r2', (frame) => frame.id.msgId === 'm-2');
        const sends = [1, 2, 3].map((seq) => ordered(fixture, seq));
        await offerAndConfirm(fixture, { sends, confirmations: [] });
        expect(readDataCopies(r2)).toEqual(['m-1', 'm-3']);

        const answer = await b.service.acceptIncomingMessage(gapNack(fixture, sends[2]!), 'r2');
        await settleLiveRoomCluster(fixture);

        expect(answer.left).toEqual({ code: 'unauthorized', message: 'AL repair request names no relayed message admitted to its sender' });
        expect(readDataCopies(r2)).toEqual(['m-1', 'm-3']);
    });
});

/** The line `publishRallarServerLiveWsNotice` prints for an admitted message whose notice failed to publish. */
const PUBLICATION_FAILED_LINE = 'Rallar server WS admitted publication failed for room.notification (m-1): NOTIFY failed';

/** Each recipient's ACK, offered on the instance its socket is on: instance, recipient, msgId. */
type Confirmation = readonly [LiveRoomInstance, string, string];

interface OfferAndConfirmInput {
    readonly sends: readonly ALMessage[];
    readonly confirmations: readonly Confirmation[];
}

/** The receipt fixture's room send from the origin: at-least-once, receipted by every receiver, living `LIFETIME_MS`. */
function receipted(fixture: LiveRoomClusterFixture, msgId: string): ALMessage {
    return roomMessage({ msgId, originPeerId: ORIGIN, nowMs: fixture.clock.nowMs, lifetimeMs: LIFETIME_MS });
}

/** The lane send: at-least-once, no receipt. */
function unreceipted(fixture: LiveRoomClusterFixture, msgId: string): ALMessage {
    return { ...receipted(fixture, msgId), delivery: { reliability: 'at-least-once', ack: 'none' } };
}

/** The `seq`th unreceipted send of the origin's one ordering key, as `m-<seq>`. */
function ordered(fixture: LiveRoomClusterFixture, seq: number): ALMessage {
    return { ...unreceipted(fixture, `m-${seq}`), ordering: { orderingKey: 'k', epoch: 1, seq } };
}

/** The gap NACK a recipient sends the origin on reading `later` while it misses the sequence before it. */
function gapNack(fixture: LiveRoomClusterFixture, later: ALMessage): ALMessage {
    const nowMs = fixture.clock.nowMs;
    const missingSeq = later.ordering!.seq! - 1;
    return newALNackControlMessage(
        { v: 4, msgId: 'r2-gap-1', senderId: 'r2', ts: nowMs, traceId: 'trace-live-path-missed-copy' },
        toTestALNackPayload({
            msgId: later.id.msgId,
            fromPeerId: 'r2',
            toPeerId: ORIGIN,
            reason: 'gap',
            observedAtEpochMs: nowMs,
            orderingKey: toALOrderingTrackKey(later)!,
            expectedSeq: missingSeq,
            missingRanges: [{ from: missingSeq, to: missingSeq }]
        })
    );
}

/** Offers each send from the origin on instance a and settles the cluster after each, then offers the ACKs. */
async function offerAndConfirm(fixture: LiveRoomClusterFixture, { sends, confirmations }: OfferAndConfirmInput): Promise<void> {
    for (const message of sends) {
        expect((await fixture.instances.a.service.acceptIncomingMessage(message, ORIGIN)).right).toEqual({ kind: 'admitted' });
        await settleLiveRoomCluster(fixture);
    }
    for (const [instance, recipient, msgId] of confirmations) {
        const ack = receiverAck({ msgId, originPeerId: ORIGIN, recipient, nowMs: fixture.clock.nowMs });
        expect((await instance.service.acceptIncomingMessage(ack, recipient)).left).toBeUndefined();
    }
    await settleLiveRoomCluster(fixture);
}

/** Each receipt the origin read for the message, as `phase:confirmed`, in the order the server observed them. */
function readReceiptLines(origin: SimulatedWebSocket, msgId: string): readonly string[] {
    return readOriginReceipts([origin], msgId).map(({ receipt }) => `${receipt.phase}:${receipt.confirmedRecipientPeerIds.join(',')}`);
}
