import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_VOLATILE_SESSION_MAX_BYTES,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionQosProvider } from '@shared/alm/volatile-budget/to-al-volatile-session-qos-provider.ts';

import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';

/** The origin `a` whose session budget of one is full exactly when `atTheBound`. */
function createBoundOriginFixture(atTheBound: boolean): RtcOriginOverlayFixture {
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
    return createRtcOriginOverlayFixture({
        snapshot: createOriginSnapshot(['a', 'b', 'c'], 4),
        nextHopPeerIds: ['b', 'c'],
        qosProvider: toALVolatileSessionQosProvider(undefined, budget, Date.now)
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

describe('the session volatile bound as the RTC origin\'s overloaded signal (D78, C13)', () => {
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

    it('drops a best-effort send in the planner while the session is at its bound', async () => {
        const fixture = createBoundOriginFixture(true);

        expect((await enqueueAndDrain(fixture.manager, createBestEffortMulticast('over'))).verdict)
            .toMatchObject({ kind: 'skipped', reason: 'planner-drop' });
    });

    it('still admits an at-least-once send at the bound: default congestion drops only low priority', async () => {
        const fixture = createBoundOriginFixture(true);

        expect(
            (await enqueueAndDrain(fixture.manager, createOriginReceiverMulticast('at-least-once')))
                .verdict.kind
        )
            .toBe('admitted');
    });
});
