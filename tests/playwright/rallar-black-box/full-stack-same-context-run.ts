import type { Page } from '@playwright/test';

import type { RallarBlackBoxTestRecipe } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    closeBrowserControlAgentPage,
    hasPassedCommandEvent,
    openBrowserControlAgentInContext,
    readFullStackConfig,
    runRecipeOnAgent,
    startRecipeRun,
    startRecipientRecipeRun,
    uniqueAgentId,
    waitForControlRunAgent,
    type FullStackTestIdentity,
    type RecipePair,
    type RecipePairOutcome,
    type RecipePairRun,
    type RecipeRunAgent,
    type RecipeRunOutcome,
    type StartedRecipeRun,
    type TwoAgentRun,
    type TwoAgentRunParticipant
} from './full-stack-helpers.ts';

/**
 * How the owner's page ends: closed, or through a lifecycle flush and a renderer crash, which runs no `pagehide`
 * listener and no later timer, so the successor restores only what the page saved before the crash.
 */
export type SameContextOwnerEnd = 'close' | 'flush-and-crash';

/** The page that owns the sender's session for one scenario, and the page of the same context that follows it. */
export interface SameContextPages {
    readonly owner: SameContextRecipeOwner;
    readonly successor: RecipeRunAgent;
    readonly ownerEnd: SameContextOwnerEnd;
    /**
     * The owner's command after which the successor starts while the owner's recipe still runs, its page ended once
     * both are done; undefined runs the owner's recipe to its end and ends its page before the successor starts.
     */
    readonly successorGate: string | undefined;
}

export interface SameContextRecipes extends RecipePair {
    readonly successor: RallarBlackBoxTestRecipe;
}

export interface SameContextOutcome extends RecipePairOutcome {
    readonly successor: RecipeRunOutcome;
}

interface OpenSuccessorPageInput {
    readonly testInfo: FullStackTestIdentity;
    readonly run: Pick<TwoAgentRun, 'request' | 'runId' | 'group'>;
    readonly owner: Pick<TwoAgentRunParticipant, 'context' | 'actor' | 'connection'>;
}

export interface SameContextRecipeOwner extends RecipeRunAgent {
    readonly page: Page;
}

/** Well under the checkpoint interval: the flush's one readwrite commits in milliseconds on an idle page. */
const FLUSH_COMMIT_SETTLE_MS = 250;

/** The owner's prologue and its gate: a connect, which may wait for ready RTC peers, and the steps before the gate. */
const SUCCESSOR_GATE_TIMEOUT_MS = 90_000;
const SUCCESSOR_GATE_POLL_INTERVAL_MS = 250;

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
        diagnosticsRole: 'successor'
    });
    try {
        await waitForControlRunAgent(input.run.request, input.run.runId, agentId);
        if (opened.diagnostics === undefined) {
            throw new Error('A completed successor participant must own diagnostics.');
        }
        return {
            agentId,
            actor: input.owner.actor,
            principalId: opened.session.clientId,
            connection: input.owner.connection,
            context: input.owner.context,
            page: opened.page,
            diagnostics: opened.diagnostics
        };
    }
    catch (error) {
        try {
            await closeBrowserControlAgentPage(opened.page);
        }
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Successor registration and page cleanup failed.', {
                cause: error
            });
        }
        throw error;
    }
}

/**
 * The server keeps one socket per auth session and a second one replaces the first. Without a gate the two pages never
 * connect at once: the owner runs the sender recipe and ends, and only then does the successor run. With one, the
 * successor's connect replaces the running owner's socket, which stays closed, as a replaced tab's does.
 */
export async function runRecipeTrioOnSameContext(
    run: RecipePairRun,
    pages: SameContextPages,
    recipes: SameContextRecipes
): Promise<SameContextOutcome> {
    const receiverRun = await startRecipientRecipeRun(run, run.receiver, recipes.receiver);
    const pageRuns = pages.successorGate === undefined
        ? await runOwnerThenSuccessor(run, pages, recipes)
        : await runSuccessorBesideOwner(run, { ...pages, successorGate: pages.successorGate }, recipes);
    const [sender, successor, receiver] = await Promise.allSettled([
        pageRuns.sender,
        pageRuns.successor.readOutcome(),
        receiverRun.readOutcome()
    ]);
    if (pages.successorGate !== undefined) {
        await endOwnerPage(pages.owner.page, pages.ownerEnd);
    }
    return { sender: requireOutcome(sender), receiver: requireOutcome(receiver), successor: requireOutcome(successor) };
}

interface SameContextPageRuns {
    readonly sender: Promise<RecipeRunOutcome>;
    readonly successor: StartedRecipeRun;
}

async function runOwnerThenSuccessor(
    run: RecipePairRun,
    pages: SameContextPages,
    recipes: SameContextRecipes
): Promise<SameContextPageRuns> {
    const sender = await runRecipeOnAgent(run, pages.owner, recipes.sender);
    await endOwnerPage(pages.owner.page, pages.ownerEnd);
    return {
        sender: Promise.resolve(sender),
        successor: await startRecipeRun(run, pages.successor, recipes.successor)
    };
}

/** The successor starts once the owner's gate command passed, or at once when the owner's recipe already ended. */
async function runSuccessorBesideOwner(
    run: RecipePairRun,
    pages: SameContextPages & Readonly<{ successorGate: string; }>,
    recipes: SameContextRecipes
): Promise<SameContextPageRuns> {
    const ownerRun = await startRecipeRun(run, pages.owner, recipes.sender);
    const deadlineEpochMs = Date.now() + SUCCESSOR_GATE_TIMEOUT_MS;
    while (Date.now() < deadlineEpochMs) {
        const snapshot = await run.readSnapshot();
        if (
            hasPassedCommandEvent(snapshot, pages.successorGate) ||
            snapshot.results.some((result) => result.commandId === ownerRun.commandId)
        ) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, SUCCESSOR_GATE_POLL_INTERVAL_MS));
    }
    return { sender: ownerRun.readOutcome(), successor: await startRecipeRun(run, pages.successor, recipes.successor) };
}

function requireOutcome(outcome: PromiseSettledResult<RecipeRunOutcome>): RecipeRunOutcome {
    if (outcome.status === 'rejected') {
        throw outcome.reason;
    }
    return outcome.value;
}

/**
 * A headless page is never hidden, and `Page.setWebLifecycleState` freezes no visible page, so the lane fires the
 * page's own `freeze` event, gives the readwrite it starts time to commit, and crashes the renderer.
 */
async function endOwnerPage(page: Page, end: SameContextOwnerEnd): Promise<void> {
    let crashCommand: Promise<void> | undefined;
    if (end === 'flush-and-crash') {
        await page.evaluate((eventType) => document.dispatchEvent(new Event(eventType)), 'freeze');
        await page.waitForTimeout(FLUSH_COMMIT_SETTLE_MS);
        const cdp = await page.context().newCDPSession(page);
        await new Promise<void>((resolve, reject) => {
            let observedCrash = false;
            const onCrash = (): void => {
                observedCrash = true;
                page.off('crash', onCrash);
                resolve();
            };
            page.on('crash', onCrash);
            // Page.crash is unanswered until target disposal; close follows the actual crash event.
            crashCommand = cdp.send('Page.crash').then(
                () => undefined,
                (error: unknown) => {
                    page.off('crash', onCrash);
                    if (!observedCrash) {
                        reject(error);
                    }
                    else if (!page.isClosed()) {
                        throw error;
                    }
                    // The observed crashed page has closed: its separately attached CDP session was disposed.
                }
            );
        });
    }
    await page.close();
    await crashCommand;
}
