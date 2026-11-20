import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    createWsReceiptedSendLink,
    LINK_MESSAGE_TTL_MS,
    LINK_START_MS,
    toRoomNotice,
    type WsReceiptedSendLink
} from '../../../services/ws-receipted-send-link-fixture.ts';

describe('a WS client\'s receipted room send the server retains behind its room view', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(LINK_START_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('a server in step answers admitted, and the one frame is delivered', async () => {
        const link = await createWsReceiptedSendLink('in-sync');
        const sent = await link.send(toRoomNotice());
        await link.advance(0);
        await advanceThroughDeadline(link);

        expect(link.serverControls.map((answer) => answer.control)).toContain('receipt:admitted');
        expect(link.written).toEqual([sent.id.msgId]);
        expect(link.deliveredToPeer(sent)).toBe(1);
        expect(toTerminalKinds(link)).toEqual([]);
    });

    it.each([1_000, 9_000])(
        'a server behind for %i ms ends the first-hop wait with its not-yet-in-sync answer: one frame, nothing stated, delivered once it catches up',
        async (behindMs) => {
            const link = await createWsReceiptedSendLink('behind');
            const sent = await link.send(toRoomNotice());
            await link.advance(0);

            expect(link.serverControls.map((answer) => answer.admission)).toEqual(['committed']);
            expect(await link.readSenderRows(sent)).toEqual({ waits: false, ended: false });
            expect(await link.readFirstHopTimeoutStatus(sent)).toBe(EntityStatus.COMPLETED);
            expect(await link.readWorkReadyAt()).toBeUndefined();

            for (let elapsedMs = 0; elapsedMs < behindMs; elapsedMs += 1_000) {
                await link.advance(1_000);
            }
            expect(link.deliveredToPeer(sent)).toBe(0);
            link.setRoomView('in-sync');
            await link.advance(200);
            expect(link.deliveredToPeer(sent)).toBe(1);

            await advanceThroughDeadline(link);
            expect(link.written).toEqual([sent.id.msgId]);
            expect(link.deliveredToPeer(sent)).toBe(1);
            expect(toTerminalKinds(link)).toEqual([]);
            expect((await link.readSenderRows(sent)).ended).toBe(false);
        }
    );
});

/** Steps of one second to past the message's deadline: every first-hop deadline the send could have is reached. */
async function advanceThroughDeadline(link: WsReceiptedSendLink): Promise<void> {
    for (let step = 0; step <= LINK_MESSAGE_TTL_MS / 1_000; step += 1) {
        await link.advance(1_000);
    }
}

/** The kinds of the facts stated that would end the message: a terminal receipt, a relay's refusal, a refused re-plan. */
function toTerminalKinds(link: WsReceiptedSendLink): readonly string[] {
    return link.settlements.flatMap((fact) =>
        fact.kind === 'receipt-exhausted' || fact.kind === 'relay-rejected' ||
            (fact.kind === 'admission' && fact.verdict.kind === 'refused') ||
            (fact.kind === 'acknowledgement' && fact.complete)
            ? [fact.kind]
            : []
    );
}
