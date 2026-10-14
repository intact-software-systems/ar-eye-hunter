import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALQosInputProvider, ALQosNormalizationInput } from '@shared/al-contracts/al-policy.ts';

import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';

/** The live state a carrier reads for the session's own sends; a forward or an arrival reads none. */
function createOwnSendLiveProvider(live: NonNullable<ALQosNormalizationInput['live']>): ALQosInputProvider {
    return {
        liveForMessage: (_msg, context) => context.direction === 'outbound' && context.fromPeerId === undefined ? live : undefined
    };
}

function createCongestedOriginFixture(live: NonNullable<ALQosNormalizationInput['live']>): RtcOriginOverlayFixture {
    return createRtcOriginOverlayFixture({
        snapshot: createOriginSnapshot(['a', 'b', 'c'], 4),
        nextHopPeerIds: ['b', 'c'],
        qosProvider: createOwnSendLiveProvider(live)
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

function readCongestionEvents(fixture: RtcOriginOverlayFixture) {
    return fixture.diagnostics.filter((event) => event.kind === 'congestion');
}

describe('the RTC origin\'s congestion drop, by its cause', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('refuses a best-effort send its carrier reads as backpressured as congested, and sends nothing', async () => {
        const fixture = createCongestedOriginFixture({ backpressured: true });
        const message = createBestEffortMulticast('backpressured');

        const verdict = (await enqueueAndDrain(fixture.manager, message)).verdict;

        expect(verdict).toMatchObject({ kind: 'refused', reason: 'congested' });
        expect(verdict).not.toHaveProperty('limit');
        expect(fixture.channels.b!.sent).toEqual([]);
        expect(readCongestionEvents(fixture)).toEqual([{
            kind: 'congestion',
            carrier: 'rtc',
            cause: 'backpressured',
            action: 'drop',
            priority: 0,
            msgId: message.id.msgId
        }]);
    });

    it('admits an at-least-once send its carrier reads as backpressured and states no drop', async () => {
        const fixture = createCongestedOriginFixture({ backpressured: true });

        const verdict = (await enqueueAndDrain(fixture.manager, createOriginReceiverMulticast('reliable'))).verdict;

        expect(verdict.kind).toBe('admitted');
        expect(readCongestionEvents(fixture)).toEqual([]);
    });

    it('keeps an overloaded send refused for capacity and states its cause overloaded', async () => {
        const fixture = createCongestedOriginFixture({ overloaded: true, backpressured: true });
        const message = createBestEffortMulticast('overloaded');

        const verdict = (await enqueueAndDrain(fixture.manager, message)).verdict;

        expect(verdict).toMatchObject({ kind: 'refused', reason: 'capacity' });
        expect(readCongestionEvents(fixture)).toEqual([
            expect.objectContaining({ carrier: 'rtc', cause: 'overloaded', action: 'drop', msgId: message.id.msgId })
        ]);
    });
});
