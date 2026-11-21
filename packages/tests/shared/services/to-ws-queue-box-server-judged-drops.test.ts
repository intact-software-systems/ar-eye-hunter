import { describe, expect, it } from 'vitest';

import type { ALOutboundCapturedPolicy } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import type { ALOutboundDequeueAuthority } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toWsQueueBoxServerJudgedDrops } from '@shared/services/ws-queue-box-server/scope/to-ws-queue-box-server-judged-drops.ts';

function capturedPolicy(admittedAudience: readonly string[] | undefined): ALOutboundCapturedPolicy {
    return {
        persist: true,
        ackTracking: null,
        retryTracking: null,
        repairTracking: null,
        supersedenceTracking: null,
        ...(admittedAudience === undefined ? {} : { admittedAudience })
    };
}

function judgedAuthority(admittedAudience: readonly string[] | undefined): ALOutboundDequeueAuthority {
    return { admittedAudience, recipientScope: undefined };
}

describe('the captured sessions a dequeue judged out', () => {
    it('names the captured sessions the judged audience no longer holds, in captured order', () => {
        expect(toWsQueueBoxServerJudgedDrops(capturedPolicy(['d', 'a', 'c', 'b']), judgedAuthority(['b', 'a'])))
            .toEqual(['d', 'c']);
    });

    it('names none when the dequeue kept every captured session', () => {
        expect(toWsQueueBoxServerJudgedDrops(capturedPolicy(['a', 'b']), judgedAuthority(['a', 'b']))).toEqual([]);
    });

    it('names no judgement when either audience is absent', () => {
        expect([
            toWsQueueBoxServerJudgedDrops(undefined, judgedAuthority(['a'])),
            toWsQueueBoxServerJudgedDrops(capturedPolicy(undefined), judgedAuthority(['a'])),
            toWsQueueBoxServerJudgedDrops(capturedPolicy(['a']), undefined),
            toWsQueueBoxServerJudgedDrops(capturedPolicy(['a']), judgedAuthority(undefined))
        ]).toEqual([undefined, undefined, undefined, undefined]);
    });
});
