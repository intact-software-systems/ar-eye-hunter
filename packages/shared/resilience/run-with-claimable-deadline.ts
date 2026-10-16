import type { Timers } from './timers.ts';

/** The work's view of its deadline, claimed before an effect that must not take place after the deadline. */
export interface ClaimableDeadlineClaim {
    /**
     * True while the deadline has not expired; from then on the deadline no longer ends the run, which
     * settles with the work's own outcome. False once the deadline expired: the work must not take effect.
     */
    tryClaim(): boolean;
    /** Whether the deadline already ended the run, without claiming it; a claimed deadline never expires. */
    isExpired(): boolean;
}

export type ClaimableDeadlineOutcome<T> =
    | Readonly<{ kind: 'settled'; value: T; }>
    | Readonly<{ kind: 'expired'; deadlineMs: number; }>;

type ClaimableDeadlineState = 'running' | 'claimed' | 'expired';

/**
 * Runs the work against a deadline; whichever comes first of the deadline and the work's claim decides the run.
 * An expiry settles the run at once and leaves the work running unobserved, so its late failure is not surfaced;
 * a claim lets the work finish with its own outcome however long it takes.
 */
export async function runWithClaimableDeadline<T>(
    timers: Timers,
    deadlineMs: number,
    work: (claim: ClaimableDeadlineClaim) => Promise<T>
): Promise<ClaimableDeadlineOutcome<T>> {
    let state: ClaimableDeadlineState = 'running';
    const claim: ClaimableDeadlineClaim = {
        tryClaim: () => {
            if (state === 'expired') {
                return false;
            }
            state = 'claimed';
            return true;
        },
        isExpired: () => state === 'expired'
    };
    let cancelExpiry: () => void = () => undefined;
    const expiry = new Promise<ClaimableDeadlineOutcome<T>>((resolve) => {
        cancelExpiry = timers.schedule(() => {
            if (state === 'running') {
                state = 'expired';
                resolve({ kind: 'expired', deadlineMs });
            }
        }, deadlineMs);
    });
    try {
        const settled = work(claim).then((value): ClaimableDeadlineOutcome<T> => ({ kind: 'settled', value }));
        return await Promise.race([settled, expiry]);
    }
    finally {
        cancelExpiry();
    }
}
