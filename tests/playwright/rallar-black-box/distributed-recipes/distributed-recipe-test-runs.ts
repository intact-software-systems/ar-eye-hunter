import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin-ms.ts';
import { CONTROL_AGENT_OPENING_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-agent-opening-timeout-ms.ts';
import { FULL_STACK_EXPECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/playwright-expect-timeouts.ts';
import {
    type RallarBlackBoxDistributedGroupRef,
    type RallarBlackBoxDistributedRunManifest
} from '../../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import { type RallarBlackBoxTestRecipe } from '../../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { CONTROL_GET_RETRY_BOUNDED_WAITS_MS } from '../read-control-get-response.ts';
import {
    CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS,
    DISTRIBUTED_AGENT_CONFIGURE_RESULT_WAIT_MS,
    DISTRIBUTED_GROUP_REQUEST_RESULT_WAIT_MS,
    SCRIPTED_CONTROL_AGENT_OPEN_TIMEOUT_MS
} from './browser-agents.ts';
import {
    AGENTS_IN_GROUP_POLL_TIMEOUT_MS,
    computeDistributedRunToPassedWaitMs,
    DISTRIBUTED_STATE_POLL_TIMEOUT_MS
} from './distributed-control.ts';
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

/** How long the simulated failure test waits for a staged run to time out its ACK, then for a started run to run. */
export const SIMULATED_FAILURE_STATE_TIMEOUT_MS = 15_000;

/** How long the simulated failure test polls the control run for a closed agent to disconnect. */
export const SIMULATED_DISCONNECT_POLL_TIMEOUT_MS = 10_000;

/** The simulated failure test's scripted agents: the one that never acknowledges and the one whose recipe fails. */
const SIMULATED_FAILURE_SCRIPTED_AGENT_COUNT = 2;

/** The ACK timeout the simulated failure test gives its silent agent's run. */
export const SIMULATED_ACK_TIMEOUT_MS = 100;

/** The live test's three agents, the first of which sends. */
const LIVE_AGENT_COUNT = 3;

/** The test's agents: each is opened, then each is configured for the group, then all are seen in the group. */
const THREE_AGENTS_BOUNDED_WAITS_MS = 3 * CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS +
    3 * DISTRIBUTED_AGENT_CONFIGURE_RESULT_WAIT_MS + AGENTS_IN_GROUP_POLL_TIMEOUT_MS;

/** The live test's agents sign in as they open, each first waiting for its login gate. */
const THREE_SIGNED_IN_AGENTS_BOUNDED_WAITS_MS = THREE_AGENTS_BOUNDED_WAITS_MS +
    LIVE_AGENT_COUNT * CONTROL_AGENT_OPENING_TIMEOUT_MS;

/** The owner creates the live test's group, then each of the three agents joins it, one request after another. */
const LIVE_GROUP_MEMBERSHIP_BOUNDED_WAITS_MS = (1 + LIVE_AGENT_COUNT) * DISTRIBUTED_GROUP_REQUEST_RESULT_WAIT_MS;

/** Each warning diagnostic row shows its group, its severity pill and its transport pill. */
const LIVE_DIAGNOSTIC_ROW_ASSERTIONS = 3;

/** Each agent's composite card shows the recipe and no failures in its summary, then its loop and its rows. */
const LIVE_COMPOSITE_CARD_ASSERTIONS = 4;

/** The received message shows its kind pill, its topic, its connection and its transport. */
const LIVE_RECEIVED_MESSAGE_ASSERTIONS = 4;

/**
 * The live test's panel assertions that name no limit: the listed run, the two warning diagnostics' rows, the composite
 * card count, each agent's composite card, the event stream, then the received message.
 */
const LIVE_PANEL_BOUNDED_WAITS_MS = FULL_STACK_EXPECT_TIMEOUT_MS *
    (1 + 2 * LIVE_DIAGNOSTIC_ROW_ASSERTIONS + 1 + LIVE_AGENT_COUNT * LIVE_COMPOSITE_CARD_ASSERTIONS + 1 +
        LIVE_RECEIVED_MESSAGE_ASSERTIONS);

/** How long the live test's cleanup waits for each agent's best-effort close; the closes run side by side. */
export const LIVE_DISTRIBUTED_CLEANUP_CLOSE_TIMEOUT_MS = 15_000;

/** The live test reads the control run for the WS and RTC warning reports and the realtime monitor, then its summary. */
const LIVE_CONTROL_RUN_READS = 4;

/**
 * Three simulated agents; each scripted agent's socket and its in-group poll; the ACK run's timed-out wait, the
 * failing run's ready and failed waits and the disconnect run's ready wait; the closed agent's disconnect poll and the
 * disconnect run's running wait; then the control run read after it.
 */
export const SIMULATED_FAILURES_TEST_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS + THREE_AGENTS_BOUNDED_WAITS_MS +
    SIMULATED_FAILURE_SCRIPTED_AGENT_COUNT *
        (SCRIPTED_CONTROL_AGENT_OPEN_TIMEOUT_MS + AGENTS_IN_GROUP_POLL_TIMEOUT_MS) +
    SIMULATED_FAILURE_STATE_TIMEOUT_MS + 3 * DISTRIBUTED_STATE_POLL_TIMEOUT_MS + SIMULATED_DISCONNECT_POLL_TIMEOUT_MS +
    SIMULATED_FAILURE_STATE_TIMEOUT_MS + CONTROL_GET_RETRY_BOUNDED_WAITS_MS;

/** Three simulated agents, the run to passed, the panel listing it and showing it passed, then the run's summary read. */
export function computeSimulatedAckTestTimeoutMs(manifest: RallarBlackBoxDistributedRunManifest): number {
    return BROWSER_TEST_HARNESS_MARGIN_MS + THREE_AGENTS_BOUNDED_WAITS_MS +
        computeDistributedRunToPassedWaitMs(manifest) +
        SIMULATED_ACK_PANEL_TIMEOUT_MS + FULL_STACK_EXPECT_TIMEOUT_MS + CONTROL_GET_RETRY_BOUNDED_WAITS_MS;
}

/**
 * Three browser agents and the group's membership, each run to passed in turn, the WS and RTC receivers' messages (each
 * pair side by side), the realtime position payload and the two warning diagnostics side by side, the control run
 * reads, the panel's assertions, then the cleanup.
 */
export function computeLiveDistributedRecipesTestTimeoutMs(runs: LiveDistributedRecipeRuns): number {
    const toPassedMs = toLiveDistributedRecipeManifests(runs).reduce(
        (sum, manifest) => sum + computeDistributedRunToPassedWaitMs(manifest),
        0
    );
    return BROWSER_TEST_HARNESS_MARGIN_MS + THREE_SIGNED_IN_AGENTS_BOUNDED_WAITS_MS +
        LIVE_GROUP_MEMBERSHIP_BOUNDED_WAITS_MS + toPassedMs + 2 * BROWSER_MESSAGE_POLL_TIMEOUT_MS +
        REALTIME_POSITION_POLL_TIMEOUT_MS + RUNTIME_DIAGNOSTIC_POLL_TIMEOUT_MS +
        LIVE_CONTROL_RUN_READS * CONTROL_GET_RETRY_BOUNDED_WAITS_MS + LIVE_PANEL_BOUNDED_WAITS_MS +
        LIVE_DISTRIBUTED_CLEANUP_CLOSE_TIMEOUT_MS;
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
