import type { BrowserContext, Page } from '@playwright/test';

import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { runWithClaimableDeadline } from '@shared/resilience/timing/run-with-claimable-deadline.ts';
import { toError } from '@shared/resilience/to-error.ts';

/** A close releases the page's room connection and its subscriptions; well under a recipe's own budget. */
export const PAGE_CLOSE_TIMEOUT_MS = 30_000;

export interface ClosableParticipant {
    readonly page: Page;
    readonly context: BrowserContext;
}

/**
 * Cleans the participant's page for at most the page close budget, then closes its context whatever the cleanup did.
 * A cleanup that fails, or that does not settle, is reported after the close, and so is a close that fails; when both
 * failed, both are reported. A cleanup that never settles is left running unobserved, so its late failure is not
 * surfaced.
 */
export async function closeParticipantContext(
    participant: ClosableParticipant,
    cleanup: (page: Page) => Promise<void>
): Promise<void> {
    const cleanupFailure = await runCleanup(participant, cleanup);
    try {
        await participant.context.close();
    }
    catch (closeError) {
        if (cleanupFailure === undefined) {
            throw closeError;
        }
        throw new AggregateError(
            [cleanupFailure, toError(closeError)],
            `The page cleanup failed (${cleanupFailure.message}) and then closing its context failed.`
        );
    }
    if (cleanupFailure !== undefined) {
        throw cleanupFailure;
    }
}

async function runCleanup(
    participant: ClosableParticipant,
    cleanup: (page: Page) => Promise<void>
): Promise<Error | undefined> {
    try {
        const outcome = await runWithClaimableDeadline(
            createDefaultTimers(),
            PAGE_CLOSE_TIMEOUT_MS,
            async () => await cleanup(participant.page)
        );
        return outcome.kind === 'expired'
            ? new Error(`The page cleanup did not settle within ${PAGE_CLOSE_TIMEOUT_MS} ms; its context was closed.`)
            : undefined;
    }
    catch (cleanupError) {
        return toError(cleanupError);
    }
}
