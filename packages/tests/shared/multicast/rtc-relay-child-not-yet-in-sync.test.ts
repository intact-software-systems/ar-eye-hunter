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

import { toAcceptedLayout, toPromotedLayout, type SessionNextHops } from './rtc-layout-mesh-fixture.ts';
import {
    createOriginOverlay,
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain
} from './rtc-origin-overlay-fixture.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';

/**
 * What a relay does with the copy it forwarded when its child answers not yet in sync, or never answers. The NACK test
 * and the never-answers test document a known gap: a relay re-sends nothing to its child, and a relay-side re-send
 * would turn them red. The first test only pins the relay's row and receipt, and would stay green.
 */

type ChildAnswer = 'awaits-layout-promotion' | 'awaits-room-snapshot' | 'never';

interface RelayChain {
    readonly relay: RtcRelayOverlayFixture;
    readonly child: RtcRelayOverlayFixture;
    readonly frame: ALMessage;
}

const CHAIN: SessionNextHops = { a: ['c'], c: ['a', 'd'], d: ['c'] };
const NOT_OWNER = 'AL control is addressed to another outbound message owner';

/** The origin `a` sends one at-least-once frame through the relay `c` to its child `d`. */
async function forwardThroughRelay(answer: ChildAnswer): Promise<RelayChain> {
    const snapshot = createOriginSnapshot(['a', 'c', 'd'], 4);
    const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['c'], nextHopsBySessionId: CHAIN });
    const relay = createRtcRelayOverlayFixture({
        selfPeerId: 'c',
        snapshot,
        neighbourPeerIds: ['a', 'd'],
        initialOverlay: createOriginOverlay(CHAIN.c!, CHAIN)
    });
    // Awaiting the promotion, the child still holds a layout without `c` accepted, and the one that names it planned.
    const awaitsPromotion = answer === 'awaits-layout-promotion';
    const child = createRtcRelayOverlayFixture({
        selfPeerId: 'd',
        snapshot,
        neighbourPeerIds: ['c'],
        initialOverlay: createOriginOverlay(awaitsPromotion ? [] : ['c'], CHAIN)
    });
    if (awaitsPromotion) {
        child.acceptPlannedOverlay(toAcceptedLayout(snapshot, toPromotedLayout(CHAIN), 'd').overlay);
    }
    const frame = createOriginReceiverMulticast(`relay-${answer}`);
    await enqueueAndDrain(origin.manager, frame);
    await relay.receive(origin.channels.c!.sent.find((sent) => sent.id.msgId === frame.id.msgId)!, 'a');
    return { relay, child, frame };
}

/** Carries the relay's copies to the child and the child's answers back, every 500 ms for `totalMs`. */
async function exchange(chain: RelayChain, answer: ChildAnswer, totalMs: number): Promise<void> {
    let carriedDown = 0;
    let carriedUp = 0;
    for (let elapsedMs = 0; elapsedMs <= totalMs; elapsedMs += 500) {
        const down = (await chain.relay.readSent('d')).filter((sent) => sent.id.msgId === chain.frame.id.msgId);
        for (const copy of answer === 'never' ? [] : down.slice(carriedDown)) {
            // A room floor above the child's snapshot makes it answer behind its room authority.
            const carried = answer === 'awaits-room-snapshot'
                ? { ...copy, targets: { ...copy.targets!, minSnapshotVersion: 99 } } as ALMessage
                : copy;
            await chain.child.receive(carried, 'c');
        }
        carriedDown = down.length;
        const up = await chain.child.readSent('c');
        for (const control of up.slice(carriedUp)) {
            await chain.relay.receive(control, 'd');
        }
        carriedUp = up.length;
        await vi.advanceTimersByTimeAsync(500);
    }
}

async function readCopiesToChild(chain: RelayChain): Promise<number> {
    return (await chain.relay.readSent('d')).filter((sent) => sent.id.msgId === chain.frame.id.msgId).length;
}

describe('a relay\'s copy to a child that answers not yet in sync, or never', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('the relay keeps an outbound row and a receipt for the copy it forwarded, owned by the origin', async () => {
        const chain = await forwardThroughRelay('never');

        const row = await chain.relay.readOutboundMessage(chain.frame.id.msgId);
        expect(row?.reference.senderId).toBe('a');
        expect(row?.policy.retryTracking).toEqual({ enabled: true, maxAttempts: 3 });
        expect(await chain.relay.readOutboundReceipt({ originPeerId: 'a', msgId: chain.frame.id.msgId })).toMatchObject({
            expectedPeerIds: ['d'],
            ackedPeerIds: [],
            timeoutMs: 2_000,
            maxAttempts: 3,
            attempts: 0
        });
    });

    it.each(['awaits-layout-promotion', 'awaits-room-snapshot'] as const)(
        'the relay\'s outbound runtime refuses its child\'s not-yet-in-sync NACK as addressed to another owner, and re-sends nothing (%s)',
        async (answer) => {
            const chain = await forwardThroughRelay(answer);

            await exchange(chain, answer, 10_000);

            const nackAdmissions = chain.relay.outboundDiagnostics.flatMap((event) =>
                event.kind === 'control-admission' && 'nackReason' in event ? [event] : []
            );
            expect(nackAdmissions).toEqual([
                expect.objectContaining({ nackReason: 'not-yet-in-sync', outcome: 'rejected', reason: NOT_OWNER })
            ]);
            const answers = (await chain.child.readSent('c')).map((sent) => parseALControlMessage(sent)?.type);
            expect(answers).toEqual(['nack']);
            expect(await readCopiesToChild(chain)).toBe(1);
        }
    );

    // The receipt's ack timeout charges its three attempts, but each re-plan of the stored copy finds no route
    // (the stored copy is the one addressed to the relay itself), so no repair is planned and nothing is re-sent.
    it('a child that never answers spends the relay\'s receipt attempts with no copy re-sent', async () => {
        const chain = await forwardThroughRelay('never');
        const receipt = { originPeerId: 'a', msgId: chain.frame.id.msgId };
        const attempts: (number | undefined)[] = [];

        for (let elapsedMs = 0; elapsedMs < 10_000; elapsedMs += 2_500) {
            await vi.advanceTimersByTimeAsync(2_500);
            await chain.relay.readSent('d');
            attempts.push((await chain.relay.readOutboundReceipt(receipt))?.attempts);
        }

        expect(attempts.filter((attempt) => attempt !== undefined)).toEqual([1, 2, 3]);
        expect(attempts.at(-1)).toBeUndefined();
        expect(await readCopiesToChild(chain)).toBe(1);
    });
});
