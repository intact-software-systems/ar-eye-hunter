import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

import type { SimulatedWebSocket } from '../../../../shared/native-websocket-fixture.ts';
import { readOriginReceipts, receiverAck, roomMessage } from '../../../../shared/services/ws-queue-box-server-receipt-fixture.ts';
import {
    connectLiveRoomSession,
    createLiveRoomClusterFixture,
    readDataCopies,
    settleLiveRoomCluster,
    type LiveRoomClusterFixture,
    type LiveRoomInstance
} from './live-room-cluster-fixture.ts';

const ORIGIN = 'p';
const ROOM = [ORIGIN, 'r1', 'r2'];
const LIFETIME_MS = 10_000;
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
});

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
