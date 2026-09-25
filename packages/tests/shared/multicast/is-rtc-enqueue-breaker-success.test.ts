import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALBroadcastMessage } from '@shared/al-contracts/al-contract.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';

import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain
} from './rtc-origin-overlay-fixture.ts';

describe('the RTC enqueue circuit breaker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('does not count a typed unsupported refusal as a transport failure', async () => {
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b', 'c'], 4),
            nextHopPeerIds: ['b', 'c'],
            circuitBreaker: toCircuitBreaker(2)
        });
        for (const resourceId of ['world-1', 'world-2', 'world-3']) {
            const refused = await enqueueAndDrain(
                fixture.manager,
                newALBroadcastMessage('a', { topicId: 'chat', resourceId, contextId: 'world' }, 'world', 'chat.v1', {}, {
                    ack: 'receiver',
                    reliability: 'at-least-once'
                })
            );
            expect(refused.verdict).toMatchObject({ kind: 'refused', reason: 'unsupported' });
        }

        const admitted = await enqueueAndDrain(fixture.manager, createOriginReceiverMulticast('after-refusals'));

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
    });
});
