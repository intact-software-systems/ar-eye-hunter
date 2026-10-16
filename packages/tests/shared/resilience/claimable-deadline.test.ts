import { describe, expect, it } from 'vitest';

import { runWithClaimableDeadline } from '@shared/resilience/claimable-deadline.ts';

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
