import type { TestInfo } from '@playwright/test';

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

/** The page that owns the sender's session for one scenario, and the page of the same context that follows it. */
export interface SameContextPages {
    readonly owner: TwoAgentRunParticipant;
    readonly successor: TwoAgentRunParticipant;
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
    await pages.owner.page.close();
    const [successor, receiver] = await Promise.all([
        runRecipeOnAgent(run, pages.successor, recipes.successor),
        receiverRun.outcome
    ]);
    return { sender, receiver, successor };
}
