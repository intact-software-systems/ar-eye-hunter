import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import {
    AL_VOLATILE_SESSION_MAX_BYTES,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionQosProvider } from '@shared/alm/volatile-budget/to-al-volatile-session-qos-provider.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';

/** A session budget of one admission, full exactly when `atTheBound`, read as the QoS provider of the session. */
function createBoundQosProvider(atTheBound: boolean): ALQosInputProvider {
    const budget = new ALVolatileSessionBudget({
        maxAdmissions: 1,
        maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
    });
    if (atTheBound) {
        budget.record({
            msgId: 'received',
            bytes: 1,
            deadlineAtMs: Date.now() + 60_000,
            nowMs: Date.now()
        });
    }
    return toALVolatileSessionQosProvider(undefined, budget, Date.now);
}

/** The origin `a` whose session budget of one is full exactly when `atTheBound`. */
function createBoundOriginFixture(atTheBound: boolean): RtcOriginOverlayFixture {
    return createRtcOriginOverlayFixture({
        snapshot: createOriginSnapshot(['a', 'b', 'c'], 4),
        nextHopPeerIds: ['b', 'c'],
        qosProvider: createBoundQosProvider(atTheBound)
    });
}

/** The session `selfPeerId`, at its bound, receiving from the origin `a` in `snapshot`. */
function createOverloadedPeer(
    selfPeerId: string,
    snapshot: GroupSnapshot,
    neighbourPeerIds: readonly string[]
): RtcRelayOverlayFixture {
    return createRtcRelayOverlayFixture({
        selfPeerId,
        snapshot,
        neighbourPeerIds,
        qosProvider: createBoundQosProvider(true)
    });
}

function createBestEffortMulticast(resourceId: string): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'chat', resourceId, contextId: 'room' },
        ORIGIN_ROOM,
        'chat.message.v1',
        { text: resourceId },
        { reliability: 'best-effort', ack: 'none', ttlMs: 30_000 }
    );
}

function readCopies(sent: readonly ALMessage[], message: ALMessage): number {
    return sent.filter((copy) => copy.id.msgId === message.id.msgId).length;
}

describe('the session volatile bound as the RTC origin\'s overloaded signal (D78)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('admits a best-effort send while the session is under its bound', async () => {
        const fixture = createBoundOriginFixture(false);

        expect(
            (await enqueueAndDrain(fixture.manager, createBestEffortMulticast('under'))).verdict
                .kind
        ).toBe('admitted');
    });

    it('refuses a best-effort room send at the bound for capacity, as the admission bound itself would', async () => {
        const fixture = createBoundOriginFixture(true);

        expect((await enqueueAndDrain(fixture.manager, createBestEffortMulticast('over'))).verdict)
            .toMatchObject({ kind: 'refused', reason: 'capacity' });
        expect(fixture.channels.b!.sent).toEqual([]);
    });

    it('leaves an at-least-once send to the admission bound: default congestion drops only low priority', async () => {
        // The pairs of this origin carry no budget, so only the planner could refuse here.
        const fixture = createBoundOriginFixture(true);

        expect(
            (await enqueueAndDrain(fixture.manager, createOriginReceiverMulticast('at-least-once')))
                .verdict.kind
        )
            .toBe('admitted');
    });
});

describe('what a session at its volatile bound still does for other sessions (D78)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('acknowledges an at-least-once room message over RTC', async () => {
        const snapshot = createOriginSnapshot(['a', 'b', 'c'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c'] });
        const b = createOverloadedPeer('b', snapshot, ['a', 'c']);
        const message = createOriginReceiverMulticast('acknowledged-at-the-bound');
        await enqueueAndDrain(origin.manager, message);

        await b.receive(origin.channels.b!.sent[0]!, 'a');

        const controls = (await b.readSent('a')).map((control) => parseALControlMessage(control));
        expect(controls).toEqual([
            expect.objectContaining({
                type: 'ack',
                payload: expect.objectContaining({ ackedMsgId: message.id.msgId, status: 'delivered' })
            })
        ]);
    });

    it('delivers a best-effort arrival to its own inbox at once', async () => {
        const snapshot = createOriginSnapshot(['a', 'b', 'c'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c'] });
        const b = createOverloadedPeer('b', snapshot, ['a', 'c']);
        const message = createBestEffortMulticast('delivered-at-the-bound');
        await enqueueAndDrain(origin.manager, message);

        await b.receive(origin.channels.b!.sent[0]!, 'a');

        expect(b.delivered.map((delivered) => delivered.id.msgId)).toEqual([message.id.msgId]);
    });

    it('forwards another session\'s best-effort message to the child it owns', async () => {
        const snapshot = createOriginSnapshot(['a', 'b', 'c', 'd'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c'] });
        const b = createOverloadedPeer('b', snapshot, ['a', 'c', 'd']);
        const message = createBestEffortMulticast('forwarded-at-the-bound');
        await enqueueAndDrain(origin.manager, message);

        await b.receive(origin.channels.b!.sent[0]!, 'a');

        expect(readCopies(await b.readSent('d'), message)).toBe(1);
    });
});
