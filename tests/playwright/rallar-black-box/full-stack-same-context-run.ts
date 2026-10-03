import type { Page, TestInfo } from '@playwright/test';

import type { RallarBlackBoxTestRecipe } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    openBrowserControlAgentInContext,
    readFullStackConfig,
    runRecipeOnAgent,
    startRecipientRecipeRun,
    uniqueAgentId,
    waitForControlRunAgent,
    type RecipePair,
    type RecipePairOutcome,
    type RecipeRunOutcome,
    type TwoAgentRun,
    type TwoAgentRunParticipant
} from './full-stack-helpers.ts';

/**
 * How the owner's page ends: closed, or through a lifecycle flush and a renderer crash, which runs no `pagehide`
 * listener and no later timer, so the successor restores only what the page saved before the crash.
 */
export type SameContextOwnerEnd = 'close' | 'flush-and-crash';

/** Well under the checkpoint interval: the flush's one readwrite commits in milliseconds on an idle page. */
const FLUSH_COMMIT_SETTLE_MS = 250;

/** The page that owns the sender's session for one scenario, and the page of the same context that follows it. */
export interface SameContextPages {
    readonly owner: TwoAgentRunParticipant;
    readonly successor: TwoAgentRunParticipant;
    readonly ownerEnd: SameContextOwnerEnd;
}

export interface SameContextRecipes extends RecipePair {
    readonly successor: RallarBlackBoxTestRecipe;
}

export interface SameContextOutcome extends RecipePairOutcome {
    readonly successor: RecipeRunOutcome;
}

interface OpenSuccessorPageInput {
    readonly testInfo: TestInfo;
    readonly run: TwoAgentRun;
    readonly owner: TwoAgentRunParticipant;
}

/**
 * A second page of the owner's browser context: the same storage and auth session, an agent of its own. The owner is
 * a two-agent run's sender, user A, whose credentials the page uses only if its login gate shows.
 */
export async function openSuccessorPage(input: OpenSuccessorPageInput): Promise<TwoAgentRunParticipant> {
    const config = readFullStackConfig();
    const agentId = uniqueAgentId(input.testInfo, 'alm-successor');
    const opened = await openBrowserControlAgentInContext(input.owner.context, {
        config,
        user: config.userA,
        runId: input.run.runId,
        agentId,
        groupId: input.run.group.groupId,
        connection: input.owner.connection,
        diagnosticsRole: 'successor'
    });
    await waitForControlRunAgent(input.run.request, input.run.runId, agentId);
    return {
        agentId,
        actor: input.owner.actor,
        connection: input.owner.connection,
        context: input.owner.context,
        page: opened.page,
        diagnostics: opened.diagnostics
    };
}

/**
 * The server keeps one socket per auth session and a second one replaces the first, which reconnects in turn, so the
 * two pages never connect at once: the owner runs the sender recipe and closes, and only then does the successor run.
 */
export async function runRecipeTrioOnSameContext(
    run: TwoAgentRun,
    pages: SameContextPages,
    recipes: SameContextRecipes
): Promise<SameContextOutcome> {
    const receiverRun = await startRecipientRecipeRun(run, run.receiver, recipes.receiver);
    const sender = await runRecipeOnAgent(run, pages.owner, recipes.sender);
    await endOwnerPage(pages.owner.page, pages.ownerEnd);
    const [successor, receiver] = await Promise.all([
        runRecipeOnAgent(run, pages.successor, recipes.successor),
        receiverRun.outcome
    ]);
    return { sender, receiver, successor };
}

/**
 * A headless page is never hidden, and `Page.setWebLifecycleState` freezes no visible page, so the lane fires the
 * page's own `freeze` event, gives the readwrite it starts time to commit, and crashes the renderer.
 */
async function endOwnerPage(page: Page, end: SameContextOwnerEnd): Promise<void> {
    if (end === 'flush-and-crash') {
        await page.evaluate((eventType) => document.dispatchEvent(new Event(eventType)), 'freeze');
        await page.waitForTimeout(FLUSH_COMMIT_SETTLE_MS);
        const cdp = await page.context().newCDPSession(page);
        const crashed = page.waitForEvent('crash');
        void cdp.send('Page.crash').catch(() => undefined);
        await crashed;
    }
    await page.close();
}
