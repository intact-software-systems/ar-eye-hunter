import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createInitialALDeliveryLifecycle } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { computeALDeliveryLifecycle } from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';

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
        const lifecycle = facts.reduce(
            computeALDeliveryLifecycle,
            createInitialALDeliveryLifecycle({
                msgId: sent.id.msgId,
                typeId: 'notice.v1',
                ackMode: 'receiver',
                receiptAlgo: 'receiver',
                expiresAtMs: undefined,
                submittedAtMs: 0
            })
        );
        expect(lifecycle.state).toBe('rejected');
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
