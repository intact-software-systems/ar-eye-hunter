import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    createInitialALDeliveryLifecycle,
    type ALDeliveryLifecycle,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { computeALDeliveryDeadline, computeALDeliveryLifecycle } from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';

import {
    createWsReceiptedSendLink,
    LINK_MESSAGE_TTL_MS,
    LINK_START_MS,
    toOrderedRoomNotice,
    toRoomNotice,
    toRoomUnicast,
    type WsReceiptedSendLink,
    type WsReceiptedSendServerControl
} from './ws-receipted-send-link-fixture.ts';

const NO_RECEIPT = 'names no receipt this server aggregates';

describe('a WS sender\'s reading of a room send its server kept', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(LINK_START_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('kept behind the room view, then admitted: not-yet-in-sync, then admitted, then complete', async () => {
        const link = await createWsReceiptedSendLink('behind');
        const sent = await link.send(toRoomNotice());
        await link.advance(1_000);
        expect((await link.acknowledge(sent)).left?.message).toContain(NO_RECEIPT);

        link.setRoomView('in-sync');
        await link.advance(200);
        expect(link.deliveredToPeer(sent)).toBe(1);
        expect((await link.acknowledge(sent)).left).toBeUndefined();
        await link.advance(200);

        expect(toControlsOf(link, sent)).toEqual([
            { control: 'nack:not-yet-in-sync', admission: 'committed' },
            { control: 'receipt:admitted', admission: 'committed' },
            { control: 'receipt:complete', admission: 'committed' }
        ]);
        expect(link.readReceiptsToOrigin(sent)[0]).toMatchObject({
            phase: 'admitted',
            expectedRecipientPeerIds: ['peer-b'],
            snapshotVersion: 2
        });
        expect(link.written).toEqual([sent.id.msgId]);
        expect(link.settlements.filter((fact) => fact.kind === 'acknowledgement').at(-1)).toMatchObject({
            complete: true,
            confirmedRecipientPeerIds: ['peer-b']
        });
        expect((await link.readSenderRows(sent)).ended).toBe(true);
    });

    it('characterization: kept behind the room view to its deadline: not-yet-in-sync and nothing after it', async () => {
        const link = await createWsReceiptedSendLink('behind');
        const sent = await link.send(toRoomNotice());
        await advanceInSecondsTo(link, LINK_MESSAGE_TTL_MS + 31_000);

        expect(toControlsOf(link, sent)).toEqual([{ control: 'nack:not-yet-in-sync', admission: 'committed' }]);
        expect(link.deliveredToPeer(sent)).toBe(0);
        expect(link.written).toEqual([sent.id.msgId]);
        expect(link.settlements.filter((fact) => fact.kind === 'acknowledgement' || fact.kind === 'relay-rejected' || fact.kind === 'receipt-exhausted'))
            .toEqual([]);
        expect((await link.readSenderRows(sent)).ended).toBe(false);
    });

    it('kept behind the room view, then refused: not-yet-in-sync, then the refusal\'s NACK; the send ends rejected', async () => {
        const link = await createWsReceiptedSendLink('behind');
        const sent = await link.send(toRoomNotice());
        await link.advance(1_000);
        link.setRoomView('fenced');
        await link.advance(200);

        expect(toControlsOf(link, sent)).toEqual([
            { control: 'nack:not-yet-in-sync', admission: 'committed' },
            { control: 'nack:membership-fenced', admission: 'committed' }
        ]);
        const facts = link.settlements.filter((fact) => fact.msgId === sent.id.msgId);
        expect(facts.map(({ kind }) => kind)).toEqual(['attempt-started', 'attempt-settled', 'relay-rejected']);
        expect(facts.at(-1)).toMatchObject({ relayRejection: { relay: 'trusted-server', reason: 'membership-fenced' } });
        expect(toLifecycleState(facts, sent)).toBe('rejected');
        expect((await link.readSenderRows(sent)).ended).toBe(true);
        expect(link.deliveredToPeer(sent)).toBe(0);

        await advanceInSecondsTo(link, LINK_MESSAGE_TTL_MS + 31_000);
        expect(toControlsOf(link, sent)).toHaveLength(2);
    });

    it('a kept send polled while the view stays behind is sent nothing more', async () => {
        const link = await createWsReceiptedSendLink('behind');
        const sent = await link.send(toRoomNotice());
        for (let step = 0; step < 30; step += 1) {
            await link.advance(1_000);
        }

        expect(toControlsOf(link, sent)).toEqual([{ control: 'nack:not-yet-in-sync', admission: 'committed' }]);
    });

    it('a kept unicast whose addressee is outside the audience at catch-up is refused, not admitted to nobody', async () => {
        const link = await createWsReceiptedSendLink('behind');
        const sent = await link.send(toRoomUnicast('peer-c'));
        await link.advance(1_000);
        link.setRoomView('in-sync');
        await link.advance(200);

        expect(toControlsOf(link, sent)).toEqual([
            { control: 'nack:not-yet-in-sync', admission: 'committed' },
            { control: 'nack:unauthorized', admission: 'committed' }
        ]);
        expect(link.settlements.filter((fact) => fact.msgId === sent.id.msgId).at(-1)?.kind).toBe('relay-rejected');
        expect(link.readReceiptsToOrigin(sent)).toEqual([]);
    });

    it('kept after a lost race, then admitted: no receipt exists before the replay, then admitted and complete', async () => {
        const link = await createWsReceiptedSendLink('in-sync');
        const [, second] = await sendTwoOrderedSideBySide(link);
        expect((await link.acknowledge(second)).left?.message).toContain(NO_RECEIPT);

        await link.advance(0);
        await link.advance(200);
        expect(link.deliveredToPeer(second)).toBe(1);
        expect((await link.acknowledge(second)).left).toBeUndefined();
        await link.advance(200);

        expect(toControlsOf(link, second)).toEqual([
            { control: 'receipt:admitted', admission: 'committed' },
            { control: 'receipt:complete', admission: 'committed' }
        ]);
    });

    it('kept after a lost race, then refused by its room: no receipt is ever written for it, and the refusal\'s NACK ends it', async () => {
        const link = await createWsReceiptedSendLink('in-sync');
        const [, second] = await sendTwoOrderedSideBySide(link);
        link.setRoomView('fenced');
        await advanceInSecondsTo(link, LINK_MESSAGE_TTL_MS + 31_000);

        expect(link.readReceiptsToOrigin(second)).toEqual([]);
        expect(link.deliveredToPeer(second)).toBe(0);
        expect((await link.acknowledge(second)).left?.message).toContain(NO_RECEIPT);
        expect(toControlsOf(link, second)).toEqual([{ control: 'nack:membership-fenced', admission: 'committed' }]);
        expect(link.settlements.filter((fact) => fact.msgId === second.id.msgId).at(-1)?.kind).toBe('relay-rejected');
        expect((await link.readSenderRows(second)).ended).toBe(true);
        expect(link.written.filter((id) => id === second.id.msgId)).toHaveLength(1);
    });

    it('a send kept after a lost race whose captured audience has left by its replay expects that audience: admitted at once, timed-out at its deadline, and its handle reads expired', async () => {
        const link = await createWsReceiptedSendLink('in-sync');
        const [, second] = await sendTwoOrderedSideBySide(link);
        link.setRoomView('peer-b-left');
        await link.advance(0);
        await link.advance(200);
        await link.advance(200);

        expect(toControlsOf(link, second)).toEqual([{ control: 'receipt:admitted', admission: 'committed' }]);
        expect(link.readReceiptsToOrigin(second)).toEqual([expect.objectContaining({
            phase: 'admitted',
            expectedRecipientPeerIds: ['peer-b'],
            confirmedRecipientPeerIds: [],
            snapshotVersion: 3
        })]);

        await advanceInSecondsTo(link, LINK_MESSAGE_TTL_MS - 1_000);
        expect(readHandleState(link, second)).toBe('transport-accepted');

        await advanceInSecondsTo(link, LINK_MESSAGE_TTL_MS + 31_000);
        expect(toControlsOf(link, second)).toEqual([
            { control: 'receipt:admitted', admission: 'committed' },
            { control: 'receipt:timed-out', admission: 'committed' }
        ]);
        expect(link.settlements.filter((fact) => fact.msgId === second.id.msgId).at(-1)).toMatchObject({
            kind: 'acknowledgement',
            complete: false,
            expectedRecipientPeerIds: ['peer-b'],
            unconfirmedRecipientPeerIds: ['peer-b']
        });
        expect(readHandleState(link, second)).toBe('expired');
        expect(link.written.filter((id) => id === second.id.msgId)).toHaveLength(1);
        expect(link.deliveredToPeer(second)).toBe(0);
        expect((await link.readSenderRows(second)).ended).toBe(true);
    });

    it('characterization: a send kept behind the view, nothing captured at ingress, whose audience is the origin alone when the view catches up is admitted to nobody and reads acknowledged', async () => {
        const link = await createWsReceiptedSendLink('behind');
        const sent = await link.send(toRoomNotice());
        await link.advance(1_000);
        link.setRoomView('peer-b-left');
        await link.advance(200);

        expect(toControlsOf(link, sent)).toEqual([
            { control: 'nack:not-yet-in-sync', admission: 'committed' },
            { control: 'receipt:admitted', admission: 'committed' }
        ]);
        expect(link.readReceiptsToOrigin(sent)).toEqual([expect.objectContaining({
            phase: 'admitted',
            expectedRecipientPeerIds: [],
            snapshotVersion: 3
        })]);
        expect(readHandleState(link, sent)).toBe('acknowledged');
        expect(link.deliveredToPeer(sent)).toBe(0);
    });

    it('characterization: a send kept after a lost race whose captured audience still has one member at its replay expects exactly that member', async () => {
        const link = await createWsReceiptedSendLink('in-sync');
        const [, second] = await sendTwoOrderedSideBySide(link);
        link.setRoomView('peer-c-joined');
        await link.advance(0);
        await link.advance(200);
        await link.advance(200);

        expect(toControlsOf(link, second)).toEqual([{ control: 'receipt:admitted', admission: 'committed' }]);
        expect(link.readReceiptsToOrigin(second)).toEqual([expect.objectContaining({
            phase: 'admitted',
            expectedRecipientPeerIds: ['peer-b'],
            snapshotVersion: 4
        })]);
    });

    it('characterization: in a send kept after a lost race whose captured audience has left, an ACK from peer-b, which was never sent the frame, is counted inside the audience and draws receipt:complete', async () => {
        const link = await createWsReceiptedSendLink('in-sync');
        const [, second] = await sendTwoOrderedSideBySide(link);
        link.setRoomView('peer-b-left');
        await link.advance(0);
        await link.advance(200);
        await link.advance(200);

        expect((await link.acknowledge(second)).right).toEqual({ kind: 'control', handled: false });
        await link.advance(1_000);

        expect(link.deliveredToPeer(second)).toBe(0);
        expect(toControlsOf(link, second)).toEqual([
            { control: 'receipt:admitted', admission: 'committed' },
            { control: 'receipt:complete', admission: 'committed' }
        ]);
        expect(link.readReceiptsToOrigin(second).at(-1)).toMatchObject({
            phase: 'complete',
            expectedRecipientPeerIds: ['peer-b'],
            confirmedRecipientPeerIds: ['peer-b']
        });
        expect(readHandleState(link, second)).toBe('acknowledged');
    });

    it('a copy written while the original is kept behind the view: one admitted, delivered once', async () => {
        const link = await createWsReceiptedSendLink('behind');
        const sent = await link.send(toRoomNotice());
        await link.advance(1_000);
        expect(await link.writeCopy(sent)).toBe('pending-admission');
        await link.advance(0);

        link.setRoomView('in-sync');
        await link.advance(200);
        expect((await link.acknowledge(sent)).left).toBeUndefined();
        await link.advance(200);

        expect(toControlsOf(link, sent)).toEqual([
            { control: 'nack:not-yet-in-sync', admission: 'committed' },
            { control: 'nack:not-yet-in-sync', admission: 'rejected' },
            { control: 'receipt:admitted', admission: 'committed' },
            { control: 'receipt:complete', admission: 'committed' }
        ]);
        expect(link.deliveredToPeer(sent)).toBe(1);
    });

    it('characterization: a copy admitted after the view caught up and before the replay ran: one admitted, and the replay adds none', async () => {
        const link = await createWsReceiptedSendLink('behind');
        const sent = await link.send(toRoomNotice());
        await link.advance(0);

        link.setRoomView('in-sync');
        vi.setSystemTime(Date.now() + 10);
        expect(await link.writeCopy(sent)).toBe('admitted');
        await link.advance(200);
        expect((await link.acknowledge(sent)).left).toBeUndefined();
        await link.advance(200);

        const controls = toControlsOf(link, sent).map(({ control }) => control);
        expect(controls.filter((control) => control === 'receipt:admitted')).toHaveLength(1);
        expect(controls.filter((control) => control === 'receipt:complete')).toHaveLength(1);
        expect(link.deliveredToPeer(sent)).toBe(1);
    });

    it('characterization: a copy of a send kept after a lost race, written before its replay ran: one admitted for it', async () => {
        const link = await createWsReceiptedSendLink('in-sync');
        const [first, second] = await sendTwoOrderedSideBySide(link);
        expect(await link.writeCopy(second)).toBe('admitted');
        expect(await link.writeCopy(first)).toBe('duplicate');
        await link.advance(0);
        // A receipt written while another write holds the server sender's version is retried after a 1 ms backoff,
        // which no pass at one clock reading can pass.
        await link.advance(200);
        await link.advance(200);
        await advanceInSecondsTo(link, LINK_MESSAGE_TTL_MS + 31_000);

        expect(toControlsOf(link, second)).toEqual([
            { control: 'receipt:admitted', admission: 'committed' },
            { control: 'receipt:timed-out', admission: 'committed' }
        ]);
        expect(toControlsOf(link, first)).toEqual([
            { control: 'receipt:admitted', admission: 'committed' },
            { control: 'receipt:admitted', admission: 'rejected' },
            { control: 'receipt:timed-out', admission: 'committed' }
        ]);
        expect(link.deliveredToPeer(first)).toBe(1);
        expect(link.deliveredToPeer(second)).toBe(1);
    });

    it('a kept send that names no deadline: the client stamps one, and the receipt times out at it', async () => {
        const link = await createWsReceiptedSendLink('behind');
        const { constraints: _named, ...unbounded } = toRoomNotice();
        const sent = await link.send(unbounded);
        expect(sent.constraints).toEqual({ expiresAtMs: LINK_START_MS + LINK_MESSAGE_TTL_MS });

        await link.advance(0);
        await link.advance(1_000);
        link.setRoomView('in-sync');
        await link.advance(200);
        await advanceInSecondsTo(link, LINK_MESSAGE_TTL_MS + 1_000);

        expect(toControlsOf(link, sent)).toEqual([
            { control: 'nack:not-yet-in-sync', admission: 'committed' },
            { control: 'receipt:admitted', admission: 'committed' },
            { control: 'receipt:timed-out', admission: 'committed' }
        ]);
        expect(link.readReceiptsToOrigin(sent).map(({ phase, observedAtEpochMs }) => [phase, observedAtEpochMs - LINK_START_MS]))
            .toEqual([['admitted', 1_200], ['timed-out', 30_200]]);
        expect(link.deliveredToPeer(sent)).toBe(1);
        expect((await link.readSenderRows(sent)).ended).toBe(true);
    });
});

/** Holds the frames of two ordered notices and hands them to ingress side by side: the second loses the race. */
async function sendTwoOrderedSideBySide(link: WsReceiptedSendLink): Promise<readonly [ALMessage, ALMessage]> {
    link.holdFrames();
    const first = await link.send(toOrderedRoomNotice());
    const second = await link.send(toOrderedRoomNotice());
    expect(await link.writeHeldFramesSideBySide()).toEqual(['admitted', 'pending-admission']);
    return [first, second];
}

/** Steps of one second until the link's clock reads `elapsedMs` past its start. */
async function advanceInSecondsTo(link: WsReceiptedSendLink, elapsedMs: number): Promise<void> {
    while (Date.now() - LINK_START_MS < elapsedMs) {
        await link.advance(1_000);
    }
}

function toControlsOf(link: WsReceiptedSendLink, msg: ALMessage): readonly Omit<WsReceiptedSendServerControl, 'msgId'>[] {
    return link.serverControls
        .filter((answer) => answer.msgId === msg.id.msgId)
        .map(({ control, admission }) => ({ control, admission }));
}

function readHandleState(link: WsReceiptedSendLink, msg: ALMessage): ALDeliveryLifecycle['state'] {
    return toLifecycleState(link.settlements.filter((fact) => fact.msgId === msg.id.msgId), msg);
}

/** The state a receipted notice's handle reads now, once it has seen `facts` in order, with its own deadline applied. */
function toLifecycleState(facts: readonly ALDeliverySettlement[], msg: ALMessage): ALDeliveryLifecycle['state'] {
    const lifecycle = facts.reduce(
        computeALDeliveryLifecycle,
        createInitialALDeliveryLifecycle({
            msgId: msg.id.msgId,
            typeId: 'notice.v1',
            ackMode: 'receiver',
            receiptAlgo: 'receiver',
            expiresAtMs: msg.constraints?.expiresAtMs,
            submittedAtMs: 0
        })
    );
    return computeALDeliveryDeadline(lifecycle, Date.now()).state;
}
