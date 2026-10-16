import { describe, expect, it } from 'vitest';

import { runWithClaimableDeadline } from '@shared/resilience/run-with-claimable-deadline.ts';

import { createManualTimers } from './manual-timers.ts';

describe('runWithClaimableDeadline', () => {
    it('settles with the work outcome and cancels the deadline when the work finishes first', async () => {
        const timers = createManualTimers(0);

        const outcome = await runWithClaimableDeadline(timers, 1_000, async () => 'done');

        expect(outcome).toEqual({ kind: 'settled', value: 'done' });
        expect(timers.pendingCount()).toBe(0);
    });

    it('propagates a work failure that happens before the deadline', async () => {
        const timers = createManualTimers(0);

        await expect(
            runWithClaimableDeadline(timers, 1_000, async () => {
                throw new Error('work failed');
            })
        ).rejects.toThrow('work failed');
    });

    it('expires a work that never settles and refuses its later claim', async () => {
        const timers = createManualTimers(0);
        let claimAfterExpiry: (() => boolean) | undefined;
        const pending = runWithClaimableDeadline(timers, 1_000, (deadline) => {
            claimAfterExpiry = () => deadline.tryClaim();
            return new Promise<never>(() => undefined);
        });

        await timers.advance(1_000);

        await expect(pending).resolves.toEqual({ kind: 'expired', deadlineMs: 1_000 });
        expect(claimAfterExpiry?.()).toBe(false);
    });

    it('reports expiry without consuming the claim, so a work can stop before an unclaimed effect', async () => {
        const timers = createManualTimers(0);
        const observations: boolean[] = [];
        let deadlineView: { isExpired(): boolean; tryClaim(): boolean; } | undefined;
        const pending = runWithClaimableDeadline(timers, 1_000, (deadline) => {
            deadlineView = deadline;
            observations.push(deadline.isExpired());
            return new Promise<never>(() => undefined);
        });

        observations.push(deadlineView!.isExpired());
        await timers.advance(1_000);
        observations.push(deadlineView!.isExpired());

        await expect(pending).resolves.toEqual({ kind: 'expired', deadlineMs: 1_000 });
        expect(observations).toEqual([false, false, true]);
        expect(deadlineView!.tryClaim()).toBe(false);
    });

    it('keeps a deadline the work has claimed unexpired', async () => {
        const timers = createManualTimers(0);
        let claimedView: { isExpired(): boolean; } | undefined;
        let finish: (() => void) | undefined;
        const pending = runWithClaimableDeadline(timers, 10, (deadline) => {
            deadline.tryClaim();
            claimedView = deadline;
            return new Promise<void>((resolve) => {
                finish = resolve;
            });
        });

        await timers.advance(100);
        expect(claimedView!.isExpired()).toBe(false);
        finish?.();
        await expect(pending).resolves.toEqual({ kind: 'settled', value: undefined });
    });

    it('lets a work that claimed before the deadline finish past it with its own outcome', async () => {
        const timers = createManualTimers(0);
        let finish: ((value: string) => void) | undefined;
        const pending = runWithClaimableDeadline(timers, 1_000, (deadline) => {
            expect(deadline.tryClaim()).toBe(true);
            return new Promise<string>((resolve) => {
                finish = resolve;
            });
        });

        await timers.advance(5_000);
        finish?.('committed');

        await expect(pending).resolves.toEqual({ kind: 'settled', value: 'committed' });
    });

    it('does not surface the failure of a work abandoned at its deadline', async () => {
        const timers = createManualTimers(0);
        let fail: ((error: Error) => void) | undefined;
        const pending = runWithClaimableDeadline(timers, 10, () =>
            new Promise<never>((_resolve, reject) => {
                fail = reject;
            }));

        await timers.advance(10);
        fail?.(new Error('late failure'));

        await expect(pending).resolves.toEqual({ kind: 'expired', deadlineMs: 10 });
    });
});
