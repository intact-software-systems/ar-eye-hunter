import type {
    APIRequestContext,
    Browser,
    TestInfo
} from '@playwright/test';

import type { AlmConformanceRole } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
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

/**
 * The run's third agent: the second, distinguishable recipient (D45), user C, or a second session of the sender's
 * principal, user A signed in again in a browser context of its own.
 */
export type ThirdAgentRole = Extract<AlmConformanceRole, 'recipient-b' | 'sibling'>;

/** The two-agent run plus its third agent. */
export interface ThreeAgentRun extends TwoAgentRun {
    readonly third: TwoAgentRunParticipant;
}

export interface RecipeTrio extends RecipePair {
    readonly third: RallarBlackBoxTestRecipe;
}

export interface RecipeTrioOutcome extends RecipePairOutcome {
    readonly third: RecipeRunOutcome;
}

interface CreateThreeAgentRunInput {
    readonly browser: Browser;
    readonly request: APIRequestContext;
    readonly testInfo: TestInfo;
    readonly runId: string;
    readonly thirdRole: ThirdAgentRole;
}

export async function createThreeAgentRun(input: CreateThreeAgentRunInput): Promise<ThreeAgentRun> {
    const run = await createTwoAgentRun(input);
    const opened: TwoAgentRunParticipant[] = [];
    try {
        const third = await openThirdAgent(input, run);
        opened.push(third);
        await waitForControlRunAgent(input.request, input.runId, third.agentId);
        return {
            ...run,
            third,
            close: async () => {
                await Promise.all([run.close(), closeParticipant(third)]);
            }
        };
    }
    catch (error) {
        await Promise.all([run.close(), ...opened.map(closeParticipant)]);
        throw error;
    }
}

/**
 * Both recipients connect before the sender starts, as the receiver does in the two-agent run. The third agent starts
 * only once the receiver has connected: the receiver's prologue then creates the run's group and owns it, so the
 * roles that leave the group (recipient-b, the sender) are never its only owner, whose leave is refused.
 */
export async function runRecipeTrioOnThreeAgents(
    run: ThreeAgentRun,
    recipes: RecipeTrio
): Promise<RecipeTrioOutcome> {
    const receiverRun = await startRecipientRecipeRun(run, run.receiver, recipes.receiver);
    const thirdRun = await startRecipientRecipeRun(run, run.third, recipes.third);
    const [sender, receiver, third] = await Promise.all([
        runRecipeOnAgent(run, run.sender, recipes.sender),
        receiverRun.outcome,
        thirdRun.outcome
    ]);
    return { sender, receiver, third };
}

/** Each agent names its own connections, so the third agent uses the receiver's connection label. */
async function openThirdAgent(input: CreateThreeAgentRunInput, run: TwoAgentRun): Promise<TwoAgentRunParticipant> {
    const config = readFullStackConfig();
    const user = input.thirdRole === 'sibling' ? config.userA : config.userC;
    const agentId = uniqueAgentId(input.testInfo, `alm-${input.thirdRole}`);
    const opened = await openBrowserControlAgent(input.browser, config, user, {
        runId: input.runId,
        agentId,
        groupId: run.group.groupId,
        connection: run.receiver.connection,
        diagnosticsRole: input.thirdRole
    });
    return {
        agentId,
        actor: user.actor,
        connection: run.receiver.connection,
        context: opened.context,
        page: opened.page,
        diagnostics: opened.diagnostics
    };
}

async function closeParticipant(participant: TwoAgentRunParticipant): Promise<void> {
    await cleanupRallarPage(participant.page).catch(() => undefined);
    await participant.context.close().catch(() => undefined);
}
