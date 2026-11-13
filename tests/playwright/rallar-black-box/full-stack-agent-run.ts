import type {
    APIRequestContext,
    Browser,
    TestInfo
} from '@playwright/test';

import type { AlmConformanceRole } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import type {
    AlmConformanceContinuation
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { RallarBlackBoxTestRecipe } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    cleanupRallarPage,
    createTwoAgentRun,
    enqueueControlCommand,
    findControlResult,
    openBrowserControlAgent,
    readControlRunUntil,
    readFullStackConfig,
    startRecipeRun,
    startRecipientRecipeRun,
    toParticipantUser,
    uniqueAgentId,
    waitForControlRunAgent,
    type RecipeRun,
    type RecipeRunAgent,
    type RecipeRunOutcome,
    type StartedRecipeRun,
    type TwoAgentRun,
    type TwoAgentRunParticipant
} from './full-stack-helpers.ts';
import { waitForRecipeGate } from './full-stack-recipe-gate.ts';

/** A run's agents by the role each plays in its scenarios; the sender and the receiver are always among them. */
export interface AgentRecipeRun extends RecipeRun {
    readonly agents: ReadonlyMap<AlmConformanceRole, RecipeRunAgent>;
}

/** The two-agent run plus an agent of its own for every further role the run's family declares. */
export interface AgentRun extends TwoAgentRun, AgentRecipeRun {
    readonly agents: ReadonlyMap<AlmConformanceRole, TwoAgentRunParticipant>;
}

export interface CreateAgentRunInput {
    readonly browser: Browser;
    readonly request: APIRequestContext;
    readonly testInfo: TestInfo;
    readonly runId: string;
    /** Every role of the family; the sender's and the receiver's agents are the two-agent run's own. */
    readonly roles: readonly AlmConformanceRole[];
}

export async function createAgentRun(input: CreateAgentRunInput): Promise<AgentRun> {
    const run = await createTwoAgentRun(input);
    const opened: TwoAgentRunParticipant[] = [];
    try {
        const agents = new Map<AlmConformanceRole, TwoAgentRunParticipant>([
            ['sender', run.sender],
            ['receiver', run.receiver]
        ]);
        for (const role of input.roles.filter((candidate) => !agents.has(candidate))) {
            const agent = await openRoleAgent(input, run, role);
            opened.push(agent);
            await waitForControlRunAgent(input.request, input.runId, agent.agentId);
            agents.set(role, agent);
        }
        return {
            ...run,
            agents,
            close: async () => {
                await Promise.all([run.close(), ...opened.map(closeParticipant)]);
            }
        };
    }
    catch (error) {
        const cleanup = await Promise.allSettled([run.close(), ...opened.map(closeParticipant)]);
        const failures = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason);
        if (failures.length > 0) {
            throw new AggregateError([error, ...failures], 'Agent acquisition and cleanup failed.', { cause: error });
        }
        throw error;
    }
}

/** Each role's recipe outcome, and the outcome of a role's continuation when the scenario holds one back. */
export interface AgentRunOutcomes {
    readonly roles: ReadonlyMap<AlmConformanceRole, RecipeRunOutcome>;
    readonly continuation: RecipeRunOutcome | undefined;
}

/**
 * A gate's command may sit at the end of its role's recipe: the gate waits as long as that recipe may run. In the S4-ii
 * lanes the longest four-role recipe ran 15.7 s, so the budget keeps over ten times that.
 */
const CONTINUATION_GATE_TIMEOUT_MS = 180_000;

/**
 * The receiver starts first: its prologue creates the run's group and owns it, so a role that leaves the group is
 * never its only owner, whose leave is refused, and the owner's grants name a room that exists. Every other recipient
 * starts once the one before it connected, and the sender last. The order only keeps that ownership: a barriered
 * cell's roles start their bodies once the cell's settle passed, whatever order they started in. A continuation starts
 * on its role's agent after that role's first recipe, once its gate passed.
 */
export async function runRecipesOnAgents(
    run: AgentRecipeRun,
    recipes: ReadonlyMap<AlmConformanceRole, RallarBlackBoxTestRecipe>,
    continuation: AlmConformanceContinuation | undefined
): Promise<AgentRunOutcomes> {
    const started = new Map<AlmConformanceRole, StartedRecipeRun>();
    for (const role of toStartOrder([...recipes.keys()])) {
        const agent = requireRoleValue(run.agents, role);
        const recipe = requireRoleValue(recipes, role);
        started.set(
            role,
            role === 'sender'
                ? await startRecipeRun(run, agent, recipe)
                : await startRecipientRecipeRun(run, agent, recipe)
        );
    }
    const continued = continuation === undefined ? undefined : await startContinuation(run, continuation, started);
    const [roles, continuationOutcome] = await Promise.allSettled([
        readRoleOutcomes(started),
        continued?.readOutcome()
    ]);
    return { roles: requireSettled(roles), continuation: requireSettled(continuationOutcome) };
}

function requireSettled<T>(settled: PromiseSettledResult<T>): T {
    if (settled.status === 'rejected') {
        throw settled.reason;
    }
    return settled.value;
}

/**
 * The continuation is its role's later steps, so it starts once that role's first recipe ended, whatever its outcome,
 * and the gate passed: a page runs its recipes side by side, and a gate that passes early must not let the later steps
 * overtake the first.
 */
async function startContinuation(
    run: AgentRecipeRun,
    continuation: AlmConformanceContinuation,
    started: ReadonlyMap<AlmConformanceRole, StartedRecipeRun>
): Promise<StartedRecipeRun> {
    await requireRoleValue(started, continuation.role).readOutcome();
    await waitForRecipeGate(run, {
        commandId: continuation.gate.commandId,
        gatingRun: requireRoleValue(started, continuation.gate.role),
        timeoutMs: CONTINUATION_GATE_TIMEOUT_MS
    });
    return await startRecipeRun(run, requireRoleValue(run.agents, continuation.role), continuation.recipe);
}

async function readRoleOutcomes(
    started: ReadonlyMap<AlmConformanceRole, StartedRecipeRun>
): Promise<ReadonlyMap<AlmConformanceRole, RecipeRunOutcome>> {
    const settled = await Promise.allSettled(
        [...started].map(async ([role, recipeRun]) => [role, await recipeRun.readOutcome()] as const)
    );
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected !== undefined) {
        throw rejected.reason;
    }
    return new Map(settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []));
}

/** A close releases the page's room connection and its subscriptions; well under a recipe's own budget. */
const CLOSE_TIMEOUT_MS = 30_000;

/** Ends every agent's room connection, so the next cell's connect may name a room of its own. */
export async function closeAgentConnections(run: AgentRecipeRun, cellKey: string): Promise<void> {
    const closes = [...run.agents.values()].map(({ agentId }) => ({
        agentId,
        commandId: `close-${cellKey}-${agentId}`
    }));
    for (const { agentId, commandId } of closes) {
        await enqueueControlCommand({
            request: run.request,
            runId: run.runId,
            agentId,
            commandId,
            command: { kind: 'close' }
        });
    }
    const read = await readControlRunUntil(run, {
        timeoutMs: CLOSE_TIMEOUT_MS,
        select: (snapshot) => closes.every(({ commandId }) => findControlResult(snapshot, commandId)?.ok === true),
        accept: (closed) => closed
    });
    if (read.kind === 'accepted') {
        return;
    }
    throw new Error(`${cellKey}: not every agent closed its room connection within ${CLOSE_TIMEOUT_MS} ms.`);
}

/** The principal of each role, which a recipe's grants name: the lane passes it to recipe creation. */
export function toAgentRunPrincipalIds(
    run: Readonly<{ agents: ReadonlyMap<AlmConformanceRole, Pick<TwoAgentRunParticipant, 'principalId'>>; }>
): Readonly<Partial<Record<AlmConformanceRole, string>>> {
    return Object.fromEntries([...run.agents].map(([role, agent]) => [role, agent.principalId]));
}

function toStartOrder(roles: readonly AlmConformanceRole[]): readonly AlmConformanceRole[] {
    return [
        ...roles.filter((role) => role === 'receiver'),
        ...roles.filter((role) => role !== 'receiver' && role !== 'sender'),
        ...roles.filter((role) => role === 'sender')
    ];
}

function requireRoleValue<T>(values: ReadonlyMap<AlmConformanceRole, T>, role: AlmConformanceRole): T {
    const value = values.get(role);
    if (value === undefined) {
        throw new Error(`The run holds no ${role} for its recipe.`);
    }
    return value;
}

/** Each agent names its own connections, so a further role's agent uses the receiver's connection label. */
async function openRoleAgent(
    input: CreateAgentRunInput,
    run: TwoAgentRun,
    role: AlmConformanceRole
): Promise<TwoAgentRunParticipant> {
    const config = readFullStackConfig();
    const user = toParticipantUser(config, role);
    const agentId = uniqueAgentId(input.testInfo, `alm-${role}`);
    const opened = await openBrowserControlAgent({
        browser: input.browser,
        config,
        user,
        runId: input.runId,
        agentId,
        groupId: run.group.groupId,
        diagnosticsRole: role
    });
    if (opened.diagnostics === undefined) {
        await opened.context.close();
        throw new Error(`A completed ${role} participant must own diagnostics.`);
    }
    return {
        agentId,
        actor: user.actor,
        principalId: opened.session.clientId,
        connection: run.receiver.connection,
        context: opened.context,
        page: opened.page,
        diagnostics: opened.diagnostics
    };
}

async function closeParticipant(participant: TwoAgentRunParticipant): Promise<void> {
    try {
        await cleanupRallarPage(participant.page);
    }
    finally {
        await participant.context.close();
    }
}
