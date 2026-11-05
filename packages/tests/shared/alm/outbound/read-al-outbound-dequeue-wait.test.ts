import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

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
    readALOutboundDequeueWait,
    toALOutboundDequeueFrontOutcome,
    type ALOutboundDequeueFront
} from '@shared/alm/outbound/lane/read-al-outbound-dequeue-wait.ts';
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
        QueueBoxUtilities.toResourceEntryFromMsg(MESSAGE, EnqueuedType.RTC_OUTBOX, Temporal.Now.instant()),
        (entry) => decodePersistedALMessage(entry.resource)
    ),
    leaseUntilMs: NOW_MS + 10_000,
    expireAtTimestamp: NOW_MS + 30_000
};
/** The sequences the held row's batch claimed: the row's own track holds sequence 4 of key `held`. */
const BATCH = new Map([['held:a:0', new Set([4])]]);
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

        expect(result.kind === 'held' && result.attempt.status).toBe('retained');
        expect(toALOutboundDequeueFrontOutcome(result)).toBe('retained');
        expect(hold.settlements).toEqual([{
            kind: 'attempt-settled',
            msgId: MESSAGE.id.msgId,
            attemptId: HELD_EFFECT.effectId,
            outcome: 'not-ready',
            submissionAttempted: false,
            detail: 'RTC room transport is halted',
            willRetry: true,
            traceId: MESSAGE.id.traceId
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

        expect(await hold.read()).toEqual({ kind: 'passed', followsBatchPredecessor: false });
        expect(hold.settlements).toEqual([]);
    });

    it('passes a row its carrier admits behind its batch predecessor on to the planner, marked so', async () => {
        const hold = createHold([{ status: 'follows-batch-predecessor' }]);

        const front = await hold.read();

        expect(front).toEqual({ kind: 'passed', followsBatchPredecessor: true });
        expect(toALOutboundDequeueFrontOutcome(front)).toBe('ready');
        expect(hold.settlements).toEqual([]);
    });

    it('never waits for a carrier that reads no authority', async () => {
        const settlements: ALOutboundSettlementFact[] = [];

        expect(
            await readALOutboundDequeueWait({
                effect: HELD_EFFECT,
                batch: BATCH,
                readAuthority: undefined,
                settlements: (fact) => settlements.push(fact),
                clock: { nowMs: () => Date.now() },
                signal: new AbortController().signal
            })
        ).toEqual({ kind: 'passed', followsBatchPredecessor: false });
        expect(settlements).toEqual([]);
    });
});

interface HeldClaim {
    /** The authorities the carrier answers, in order; the last one repeats. */
    readonly authorities: ALOutboundMessageRuntime.DequeuedAdmissionAuthority[];
    readonly settlements: ALOutboundSettlementFact[];
    readonly released: ALWorkOutcome | undefined;
    read(): Promise<ALOutboundDequeueFront>;
    abort(): void;
}

function createHold(authorities: ALOutboundMessageRuntime.DequeuedAdmissionAuthority[]): HeldClaim {
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
                batch: BATCH,
                readAuthority: async (message, batch) => {
                    expect(message.id).toEqual(MESSAGE.id);
                    expect(batch).toBe(BATCH);
                    return authorities.at(-1)!;
                },
                settlements: (fact) => settlements.push(fact),
                clock: { nowMs: () => Date.now() },
                signal: controller.signal
            });
            if (result.kind === 'held' && result.attempt.status === 'retained') {
                void result.attempt.settled.then((outcome) => {
                    released = outcome;
                });
            }
            return result;
        },
        abort: () => controller.abort()
    };
}
