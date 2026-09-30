import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundSettlementFact
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { toALOutboundDequeueWork } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import {
    AL_OUTBOUND_DEQUEUE_WAIT_RECHECK_MS,
    readALOutboundDequeueWait
} from '@shared/alm/outbound/lane/read-al-outbound-dequeue-wait.ts';
import type { ALWorkAttemptResult } from '@shared/alm/work/al-work-handler.ts';
import type { ALWorkOutcome } from '@shared/alm/work/al-work-queue-port.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

const NOW_MS = 1_000;
const MESSAGE = newALMulticastMessage(
    'a',
    { topicId: 'chat', resourceId: 'held', contextId: 'room' },
    { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
    'chat.message.v1',
    {},
    { ttlMs: 30_000 }
);
/** A claimed dequeue row: its lease ends 10 s after the claim, its deadline 30 s after the send. */
const HELD_EFFECT = {
    ...toALOutboundDequeueWork<ALOutboundTransportMessage>(
        QueueBoxUtilities.toResourceEntryFromMsg(MESSAGE, EnqueuedType.RTC_OUTBOX),
        (entry) => decodePersistedALMessage(entry.resource)
    ),
    leaseUntilMs: NOW_MS + 10_000,
    expireAtTimestamp: NOW_MS + 30_000
};
const NOT_READY: ALOutboundMessageRuntime.PendingAdmissionAuthority = {
    status: 'not-ready',
    reason: 'RTC room transport is halted',
    retryAfterMs: 50
};

describe('readALOutboundDequeueWait', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('states one not-ready attempt and holds the claim in memory for 40 re-checks', async () => {
        const hold = createHold([NOT_READY]);

        const result = await hold.read();
        await vi.advanceTimersByTimeAsync(40 * AL_OUTBOUND_DEQUEUE_WAIT_RECHECK_MS);

        expect(result?.status).toBe('retained');
        expect(hold.settlements).toEqual([{
            kind: 'attempt-settled',
            msgId: MESSAGE.id.msgId,
            attemptId: HELD_EFFECT.effectId,
            outcome: 'not-ready',
            submissionAttempted: false,
            detail: 'RTC room transport is halted',
            willRetry: true
        }]);
        expect(hold.released).toBeUndefined();
    });

    it('releases the claim ready at once on the first re-check that finds the authority back', async () => {
        const hold = createHold([NOT_READY]);
        await hold.read();
        await vi.advanceTimersByTimeAsync(10 * AL_OUTBOUND_DEQUEUE_WAIT_RECHECK_MS);

        hold.authorities.push({ status: 'authorized' });
        await vi.advanceTimersByTimeAsync(AL_OUTBOUND_DEQUEUE_WAIT_RECHECK_MS);

        expect(hold.released).toEqual({
            status: 'not-ready',
            readyAtMs: NOW_MS + 11 * AL_OUTBOUND_DEQUEUE_WAIT_RECHECK_MS
        });
        expect(hold.settlements).toHaveLength(1);
    });

    it('releases the claim at its lease end when the gap outlasts it', async () => {
        const hold = createHold([NOT_READY]);
        await hold.read();

        await vi.advanceTimersByTimeAsync(10_000);

        expect(hold.released).toEqual({ status: 'not-ready', readyAtMs: NOW_MS + 10_000 });
        expect(hold.settlements).toHaveLength(1);
    });

    it('releases the claim ready at once when its owner goes away', async () => {
        const hold = createHold([NOT_READY]);
        await hold.read();

        hold.abort();
        await vi.advanceTimersByTimeAsync(0);

        expect(hold.released).toEqual({ status: 'not-ready', readyAtMs: NOW_MS });
    });

    it.each(
        [
            { status: 'authorized' },
            {
                status: 'rejected',
                reason: 'RTC selected topology is explicitly inactive or foreign'
            }
        ] as const
    )('leaves a $status authority to the planner and states nothing', async (authority) => {
        const hold = createHold([authority]);

        expect(await hold.read()).toBeUndefined();
        expect(hold.settlements).toEqual([]);
    });

    it('never waits for a carrier that reads no authority', async () => {
        const settlements: ALOutboundSettlementFact[] = [];

        expect(
            await readALOutboundDequeueWait({
                effect: HELD_EFFECT,
                readAuthority: undefined,
                settlements: (fact) => settlements.push(fact),
                clock: { nowMs: () => Date.now() },
                signal: new AbortController().signal
            })
        ).toBeUndefined();
        expect(settlements).toEqual([]);
    });
});

interface HeldClaim {
    /** The authorities the carrier answers, in order; the last one repeats. */
    readonly authorities: ALOutboundMessageRuntime.PendingAdmissionAuthority[];
    readonly settlements: ALOutboundSettlementFact[];
    readonly released: ALWorkOutcome | undefined;
    read(): Promise<ALWorkAttemptResult | undefined>;
    abort(): void;
}

function createHold(authorities: ALOutboundMessageRuntime.PendingAdmissionAuthority[]): HeldClaim {
    const settlements: ALOutboundSettlementFact[] = [];
    const controller = new AbortController();
    let released: ALWorkOutcome | undefined;
    return {
        authorities,
        settlements,
        get released() {
            return released;
        },
        read: async () => {
            const result = await readALOutboundDequeueWait({
                effect: HELD_EFFECT,
                readAuthority: async (message, prepared) => {
                    expect(message.id).toEqual(MESSAGE.id);
                    expect(prepared).toEqual([]);
                    return authorities.at(-1)!;
                },
                settlements: (fact) => settlements.push(fact),
                clock: { nowMs: () => Date.now() },
                signal: controller.signal
            });
            if (result?.status === 'retained') {
                void result.settled.then((outcome) => {
                    released = outcome;
                });
            }
            return result;
        },
        abort: () => controller.abort()
    };
}
