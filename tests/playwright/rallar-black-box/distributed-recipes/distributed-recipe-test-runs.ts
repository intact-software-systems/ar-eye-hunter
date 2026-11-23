import {
    type RallarBlackBoxDistributedGroupRef,
    type RallarBlackBoxDistributedRunManifest
} from '../../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import { type RallarBlackBoxTestRecipe } from '../../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin.ts';
import { CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS } from './browser-agents.ts';
import { AGENTS_IN_GROUP_POLL_TIMEOUT_MS, computeDistributedRunToPassedWaitMs } from './distributed-control.ts';
import {
    compositeEvidenceRecipe,
    createDistributedManifest,
    createPreprovisionedRealtimeRecipe,
    healthRecipe,
    rtcConnectRecipe,
    rtcSendRecipe,
    wsSendRecipe
} from './recipe-manifests.ts';
import {
    BROWSER_MESSAGE_POLL_TIMEOUT_MS,
    REALTIME_POSITION_POLL_TIMEOUT_MS,
    RUNTIME_DIAGNOSTIC_POLL_TIMEOUT_MS
} from './runtime-observations.ts';

/** How long the simulated test's Distributed Recipes panel may take to list its run. */
export const SIMULATED_ACK_PANEL_TIMEOUT_MS = 15_000;

/** The simulated failure test bounds each of its runs by an explicit state wait of its own. */
export const SIMULATED_FAILURES_TEST_TIMEOUT_MS = 180_000;

/** The test's agents: each is opened, then all are seen in the group. */
const THREE_AGENTS_BOUNDED_WAITS_MS = 3 * CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS + AGENTS_IN_GROUP_POLL_TIMEOUT_MS;

/** Three simulated agents, the run to passed, then the panel listing it. */
export function computeSimulatedAckTestTimeoutMs(manifest: RallarBlackBoxDistributedRunManifest): number {
    return BROWSER_TEST_HARNESS_MARGIN_MS + THREE_AGENTS_BOUNDED_WAITS_MS +
        computeDistributedRunToPassedWaitMs(manifest) +
        SIMULATED_ACK_PANEL_TIMEOUT_MS;
}

/**
 * Three browser agents, each run to passed in turn, the WS and RTC receivers' messages (each pair side by side), then
 * the realtime position payload and the two warning diagnostics side by side.
 */
export function computeLiveDistributedRecipesTestTimeoutMs(runs: LiveDistributedRecipeRuns): number {
    const toPassedMs = toLiveDistributedRecipeManifests(runs).reduce(
        (sum, manifest) => sum + computeDistributedRunToPassedWaitMs(manifest),
        0
    );
    return BROWSER_TEST_HARNESS_MARGIN_MS + THREE_AGENTS_BOUNDED_WAITS_MS + toPassedMs +
        2 * BROWSER_MESSAGE_POLL_TIMEOUT_MS + REALTIME_POSITION_POLL_TIMEOUT_MS + RUNTIME_DIAGNOSTIC_POLL_TIMEOUT_MS;
}

interface DistributedRecipeTestRunInput {
    readonly suffix: string;
    readonly controlRunId: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
}

interface LiveDistributedRecipeRunsInput extends DistributedRecipeTestRunInput {
    /** The three agents, the first of which sends. */
    readonly agentIds: readonly string[];
}

export interface LiveDistributedRecipeRuns {
    readonly ack: RallarBlackBoxDistributedRunManifest;
    readonly wsPrimer: RallarBlackBoxDistributedRunManifest;
    readonly wsSend: RallarBlackBoxDistributedRunManifest;
    readonly wsMessageId: string;
    readonly rtcConnect: RallarBlackBoxDistributedRunManifest;
    readonly rtcSend: RallarBlackBoxDistributedRunManifest;
    readonly rtcMessageId: string;
    readonly realtime: RallarBlackBoxDistributedRunManifest;
    readonly realtimeRecipe: RallarBlackBoxTestRecipe;
    readonly realtimeConnection: string;
}

export function createSimulatedAckManifest(input: DistributedRecipeTestRunInput): RallarBlackBoxDistributedRunManifest {
    const recipe = compositeEvidenceRecipe(`composite-ack-all-${input.suffix}`);
    return createDistributedManifest({
        distributedRunId: `dist-ack-${input.suffix}`,
        controlRunId: input.controlRunId,
        group: input.group,
        recipes: [{ recipeId: recipe.recipeId, recipe, profile: 'full-stack', variables: {} }],
        targetPolicy: { mode: 'all-online-group-members', expectedParticipantCount: 3 },
        displayName: 'All-agent ACK smoke'
    });
}

/** The live test's runs in the order it starts them, built before it opens an agent so its timeout covers them. */
export function createLiveDistributedRecipeRuns(input: LiveDistributedRecipeRunsInput): LiveDistributedRecipeRuns {
    const targets = toLiveRunTargets(input.agentIds);
    return {
        ack: createLiveAckRun(input),
        ...createLiveWsRuns(input, targets),
        ...createLiveRtcRuns(input, targets),
        ...createLiveRealtimeRun(input, targets)
    };
}

interface LiveRunTargets {
    readonly everyAgent: RallarBlackBoxDistributedRunManifest['targetPolicy'];
    readonly senderOnly: RallarBlackBoxDistributedRunManifest['targetPolicy'];
}

function toLiveRunTargets(agentIds: readonly string[]): LiveRunTargets {
    return {
        everyAgent: { mode: 'selected-agents', agentIds, expectedParticipantCount: agentIds.length },
        senderOnly: { mode: 'role-map', roles: { sender: [agentIds[0]] }, expectedParticipantCount: 1 }
    };
}

function createLiveAckRun(input: LiveDistributedRecipeRunsInput): RallarBlackBoxDistributedRunManifest {
    const recipe = healthRecipe(`live-ack-${input.suffix}`);
    return createDistributedManifest({
        distributedRunId: `dist-live-ack-${input.suffix}`,
        controlRunId: input.controlRunId,
        group: input.group,
        recipes: [{ recipeId: recipe.recipeId, recipe, profile: 'live', variables: {} }],
        targetPolicy: { mode: 'all-online-group-members', expectedParticipantCount: input.agentIds.length }
    });
}

/** Every agent subscribes through the primer, then the sender alone sends the message the others receive. */
function createLiveWsRuns(
    input: LiveDistributedRecipeRunsInput,
    targets: LiveRunTargets
): Pick<LiveDistributedRecipeRuns, 'wsPrimer' | 'wsSend' | 'wsMessageId'> {
    const { suffix, controlRunId, group } = input;
    const typeId = `room.rallar-black-box.distributed.ws.${suffix}`;
    const primer = wsSendRecipe(`live-ws-primer-${suffix}`, group, {
        typeId,
        topicId: typeId,
        messageId: `ws-primer-${suffix}`,
        role: 'primer'
    });
    const wsMessageId = `ws-sender-receiver-${suffix}`;
    const distributedRunId = `dist-live-ws-send-${suffix}`;
    const sender = wsSendRecipe(`live-ws-sender-${suffix}`, group, {
        typeId,
        topicId: typeId,
        messageId: wsMessageId,
        role: 'sender',
        distributedRunId
    });
    return {
        wsPrimer: createDistributedManifest({
            distributedRunId: `dist-live-ws-primer-${suffix}`,
            controlRunId,
            group,
            recipes: [{ recipeId: primer.recipeId, recipe: primer, profile: 'live-ws', variables: {} }],
            targetPolicy: targets.everyAgent
        }),
        wsSend: createSenderRun(input, { distributedRunId, recipe: sender, profile: 'live-ws' }, targets),
        wsMessageId
    };
}

/** Every agent connects, then the sender alone broadcasts the message the others receive. */
function createLiveRtcRuns(
    input: LiveDistributedRecipeRunsInput,
    targets: LiveRunTargets
): Pick<LiveDistributedRecipeRuns, 'rtcConnect' | 'rtcSend' | 'rtcMessageId'> {
    const { suffix, controlRunId, group } = input;
    const connect = rtcConnectRecipe(`live-rtc-connect-${suffix}`, group);
    const rtcMessageId = `rtc-broadcast-${suffix}`;
    const distributedRunId = `dist-live-rtc-send-${suffix}`;
    const sender = rtcSendRecipe({
        recipeId: `live-rtc-send-${suffix}`,
        group,
        messageId: rtcMessageId,
        distributedRunId
    });
    return {
        rtcConnect: createDistributedManifest({
            distributedRunId: `dist-live-rtc-connect-${suffix}`,
            controlRunId,
            group,
            recipes: [{ recipeId: connect.recipeId, recipe: connect, profile: 'live-rtc', variables: {} }],
            targetPolicy: targets.everyAgent
        }),
        rtcSend: createSenderRun(input, { distributedRunId, recipe: sender, profile: 'live-rtc' }, targets),
        rtcMessageId
    };
}

interface LiveSenderRun {
    readonly distributedRunId: string;
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly profile: string;
}

function createSenderRun(
    input: LiveDistributedRecipeRunsInput,
    run: LiveSenderRun,
    targets: LiveRunTargets
): RallarBlackBoxDistributedRunManifest {
    return createDistributedManifest({
        distributedRunId: run.distributedRunId,
        controlRunId: input.controlRunId,
        group: input.group,
        recipes: [{
            recipeId: run.recipe.recipeId,
            role: 'sender',
            recipe: run.recipe,
            profile: run.profile,
            variables: {}
        }],
        targetPolicy: targets.senderOnly
    });
}

/** Every agent runs the preprovisioned realtime stream over its own connection. */
function createLiveRealtimeRun(
    input: LiveDistributedRecipeRunsInput,
    targets: LiveRunTargets
): Pick<LiveDistributedRecipeRuns, 'realtime' | 'realtimeRecipe' | 'realtimeConnection'> {
    const distributedRunId = `dist-live-rtc-realtime-${input.suffix}`;
    const realtimeConnection = `realtime-${distributedRunId}`;
    const realtimeRecipe = createPreprovisionedRealtimeRecipe({
        recipeId: `live-rtc-realtime-${input.suffix}`,
        group: input.group,
        distributedRunId,
        connection: realtimeConnection
    });
    return {
        realtime: createDistributedManifest({
            distributedRunId,
            controlRunId: input.controlRunId,
            group: input.group,
            recipes: [{
                recipeId: realtimeRecipe.recipeId,
                recipe: realtimeRecipe,
                profile: 'live-rtc-realtime',
                variables: {}
            }],
            targetPolicy: targets.everyAgent
        }),
        realtimeRecipe,
        realtimeConnection
    };
}

/** Every run the live test starts, in order. */
export function toLiveDistributedRecipeManifests(
    runs: LiveDistributedRecipeRuns
): readonly RallarBlackBoxDistributedRunManifest[] {
    return [runs.ack, runs.wsPrimer, runs.wsSend, runs.rtcConnect, runs.rtcSend, runs.realtime];
}
