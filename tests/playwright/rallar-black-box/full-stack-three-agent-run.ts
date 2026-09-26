import type {
    APIRequestContext,
    Browser,
    TestInfo
} from '@playwright/test';

import type { RallarBlackBoxTestRecipe } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    cleanupRallarPage,
    createTwoAgentRun,
    openBrowserControlAgent,
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

/** The two-agent run plus the second, distinguishable recipient (D45). */
export interface ThreeAgentRun extends TwoAgentRun {
    readonly recipientB: TwoAgentRunParticipant;
}

export interface RecipeTrio extends RecipePair {
    readonly recipientB: RallarBlackBoxTestRecipe;
}

export interface RecipeTrioOutcome extends RecipePairOutcome {
    readonly recipientB: RecipeRunOutcome;
}

interface CreateThreeAgentRunInput {
    readonly browser: Browser;
    readonly request: APIRequestContext;
    readonly testInfo: TestInfo;
    readonly runId: string;
}

export async function createThreeAgentRun(input: CreateThreeAgentRunInput): Promise<ThreeAgentRun> {
    const run = await createTwoAgentRun(input);
    const opened: TwoAgentRunParticipant[] = [];
    try {
        const recipientB = await openRecipientB(input, run);
        opened.push(recipientB);
        await waitForControlRunAgent(input.request, input.runId, recipientB.agentId);
        return {
            ...run,
            recipientB,
            close: async () => {
                await Promise.all([run.close(), closeParticipant(recipientB)]);
            }
        };
    }
    catch (error) {
        await Promise.all([run.close(), ...opened.map(closeParticipant)]);
        throw error;
    }
}

/** Both recipients connect before the sender starts, as the receiver does in the two-agent run. */
export async function runRecipeTrioOnThreeAgents(
    run: ThreeAgentRun,
    recipes: RecipeTrio
): Promise<RecipeTrioOutcome> {
    const [receiverRun, recipientBRun] = await Promise.all([
        startRecipientRecipeRun(run, run.receiver, recipes.receiver),
        startRecipientRecipeRun(run, run.recipientB, recipes.recipientB)
    ]);
    const [sender, receiver, recipientB] = await Promise.all([
        runRecipeOnAgent(run, run.sender, recipes.sender),
        receiverRun.outcome,
        recipientBRun.outcome
    ]);
    return { sender, receiver, recipientB };
}

/** Each agent names its own connections, so the second recipient uses the receiver's connection label. */
async function openRecipientB(input: CreateThreeAgentRunInput, run: TwoAgentRun): Promise<TwoAgentRunParticipant> {
    const config = readFullStackConfig();
    const agentId = uniqueAgentId(input.testInfo, 'alm-recipient-b');
    const opened = await openBrowserControlAgent(input.browser, config, config.userC, {
        runId: input.runId,
        agentId,
        groupId: run.group.groupId,
        connection: run.receiver.connection
    });
    return {
        agentId,
        actor: config.userC.actor,
        connection: run.receiver.connection,
        context: opened.context,
        page: opened.page
    };
}

async function closeParticipant(participant: TwoAgentRunParticipant): Promise<void> {
    await cleanupRallarPage(participant.page).catch(() => undefined);
    await participant.context.close().catch(() => undefined);
}
