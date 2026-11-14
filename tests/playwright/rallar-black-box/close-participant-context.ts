import type { BrowserContext, Page } from '@playwright/test';

import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { runWithClaimableDeadline } from '@shared/resilience/timing/run-with-claimable-deadline.ts';

/** A close releases the page's room connection and its subscriptions; well under a recipe's own budget. */
export const PAGE_CLOSE_TIMEOUT_MS = 30_000;

export interface ClosableParticipant {
    readonly page: Page;
    readonly context: BrowserContext;
}

/**
 * Cleans the participant's page for at most the page close budget, then closes its context whatever the cleanup did.
 * A cleanup that fails, or that does not settle, is reported after the close; a cleanup that never settles is left
 * running unobserved, so its late failure is not surfaced.
 */
export async function closeParticipantContext(
    participant: ClosableParticipant,
    cleanup: (page: Page) => Promise<void>
): Promise<void> {
    let outcome;
    try {
        outcome = await runWithClaimableDeadline(
            createDefaultTimers(),
            PAGE_CLOSE_TIMEOUT_MS,
            async () => await cleanup(participant.page)
        );
    }
    finally {
        await participant.context.close();
    }
    if (outcome.kind === 'expired') {
        throw new Error(`The page cleanup did not settle within ${PAGE_CLOSE_TIMEOUT_MS} ms; its context was closed.`);
    }
}
