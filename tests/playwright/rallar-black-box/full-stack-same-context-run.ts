import type { Page } from '@playwright/test';

import { toError } from '@shared/resilience/to-error.ts';

import type { AlmConformanceOwnerEnd } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import type { RallarBlackBoxTestRecipe } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createScenarioRoots, type ScenarioRoots } from './create-scenario-roots.ts';
import {
    closeBrowserControlAgentPage,
    openBrowserControlAgentInContext,
    readFullStackConfig,
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
import { waitForRecipeGate } from './full-stack-recipe-gate.ts';
import { toNotStartedRecipeRunOutcome } from './to-not-started-recipe-run-outcome.ts';

/** The page that owns the sender's session for one scenario, and the page of the same context that follows it. */
export interface SameContextPages {
    readonly owner: SameContextRecipeOwner;
    readonly successor: RecipeRunAgent;
    readonly ownerEnd: AlmConformanceOwnerEnd;
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
 * successor's connect replaces the running owner's socket, which stays closed, as a replaced tab's does. The three roots
 * are one scenario's, each read from its start: a root that ends not ok cancels the others still running, and the
 * successor does not start after it. A failure of the pages' own steps cancels the receiver before it is thrown.
 */
export async function runRecipeTrioOnSameContext(
    run: RecipePairRun,
    pages: SameContextPages,
    recipes: SameContextRecipes
): Promise<SameContextOutcome> {
    const scenario = createScenarioRoots();
    const receiverRun = await startRecipientRecipeRun(run, run.receiver, recipes.receiver);
    const receiver = scenario.readOutcome(receiverRun);
    const pageRuns = runPagesCancellingReceiver(run, { pages, recipes, scenario, receiverRun });
    const [pageOutcomes, receiverOutcome] = await Promise.allSettled([pageRuns, receiver]);
    const { sender, successor } = requireOutcome(pageOutcomes);
    if (pages.successorGate !== undefined) {
        await endOwnerPage(pages.owner.page, pages.ownerEnd);
    }
    return { sender, receiver: requireOutcome(receiverOutcome), successor };
}

/** The pages' own steps; their failure cancels the receiver before it is thrown, so its read ends too. */
async function runPagesCancellingReceiver(
    run: RecipePairRun,
    input: SameContextPageRunInput<SameContextPages> & Readonly<{ receiverRun: StartedRecipeRun; }>
): Promise<SameContextPageOutcomes> {
    const { pages, receiverRun, ...rest } = input;
    try {
        return pages.successorGate === undefined
            ? await runOwnerThenSuccessor(run, { ...rest, pages })
            : await runSuccessorBesideOwner(run, { ...rest, pages: { ...pages, successorGate: pages.successorGate } });
    }
    catch (error) {
        receiverRun.cancelAfter(toOwnerSideStepsFailure(input.recipes.sender, toError(error)));
        throw error;
    }
}

interface SameContextPageOutcomes {
    readonly sender: RecipeRunOutcome;
    readonly successor: RecipeRunOutcome;
}

interface SameContextPageRunInput<P extends SameContextPages> {
    readonly pages: P;
    readonly recipes: SameContextRecipes;
    readonly scenario: ScenarioRoots;
}

async function runOwnerThenSuccessor(
    run: RecipePairRun,
    input: SameContextPageRunInput<SameContextPages>
): Promise<SameContextPageOutcomes> {
    const { pages, recipes, scenario } = input;
    const sender = await scenario.readOutcome(await startRecipeRun(run, pages.owner, recipes.sender));
    await endOwnerPage(pages.owner.page, pages.ownerEnd);
    return { sender, successor: await readSuccessorOutcome(run, input) };
}

/**
 * The successor starts once the owner's gate command passed, or at once when the owner's recipe already ended; a gate
 * that does neither within its timeout fails the cell before the successor starts. A failed gate, or a successor that
 * cannot be started or read, cancels the owner first, so its read ends too.
 */
async function runSuccessorBesideOwner(
    run: RecipePairRun,
    input: SameContextPageRunInput<SameContextPages & Readonly<{ successorGate: string; }>>
): Promise<SameContextPageOutcomes> {
    const ownerRun = await startRecipeRun(run, input.pages.owner, input.recipes.sender);
    const [successor, sender] = await Promise.allSettled([
        readGatedSuccessorOutcome(run, { ...input, ownerRun }),
        input.scenario.readOutcome(ownerRun)
    ]);
    const successorOutcome = requireOutcome(successor);
    return { sender: requireOutcome(sender), successor: successorOutcome };
}

async function readGatedSuccessorOutcome(
    run: RecipePairRun,
    input:
        & SameContextPageRunInput<SameContextPages & Readonly<{ successorGate: string; }>>
        & Readonly<{
            ownerRun: StartedRecipeRun;
        }>
): Promise<RecipeRunOutcome> {
    try {
        await waitForRecipeGate(run, {
            commandId: input.pages.successorGate,
            gatingRun: input.ownerRun,
            scenario: input.scenario,
            timeoutMs: SUCCESSOR_GATE_TIMEOUT_MS
        });
        return await readSuccessorOutcome(run, input);
    }
    catch (error) {
        input.ownerRun.cancelAfter(toOwnerSideStepsFailure(input.recipes.sender, toError(error)));
        throw error;
    }
}

/** The successor starts while no root of the scenario ended not ok; after one did, it is reported not started. */
async function readSuccessorOutcome(
    run: RecipePairRun,
    { pages, recipes, scenario }: SameContextPageRunInput<SameContextPages>
): Promise<RecipeRunOutcome> {
    const failure = scenario.getFailure();
    return failure === undefined
        ? await scenario.readOutcome(await startRecipeRun(run, pages.successor, recipes.successor))
        : toNotStartedRecipeRunOutcome(recipes.successor, failure);
}

/**
 * What a root cancelled after a failed lane step beside the owner's recipe is cancelled after: the lane's own steps
 * there (its page steps, its gate wait, its start and read of the successor), named for the owner's recipe they run
 * beside, and not that recipe, which may still be running when they fail.
 */
function toOwnerSideStepsFailure(owner: RallarBlackBoxTestRecipe, error: Error): RecipeRunOutcome {
    return { commandId: `${owner.recipeId}-side-steps`, ok: false, summary: error.message, cancelledAfter: undefined };
}

function requireOutcome<T>(outcome: PromiseSettledResult<T>): T {
    if (outcome.status === 'rejected') {
        throw outcome.reason;
    }
    return outcome.value;
}

/**
 * A headless page is never hidden, and `Page.setWebLifecycleState` freezes no visible page, so the lane fires the
 * page's own `freeze` event, gives the readwrite it starts time to commit, and crashes the renderer.
 */
async function endOwnerPage(page: Page, end: AlmConformanceOwnerEnd): Promise<void> {
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
