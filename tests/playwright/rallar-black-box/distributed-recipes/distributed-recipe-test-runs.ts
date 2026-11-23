import {
    type RallarBlackBoxDistributedGroupRef,
    type RallarBlackBoxDistributedRunManifest
} from '../../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import { type RallarBlackBoxTestRecipe } from '../../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import {
    compositeEvidenceRecipe,
    createDistributedManifest,
    createPreprovisionedRealtimeRecipe,
    healthRecipe,
    rtcConnectRecipe,
    rtcSendRecipe,
    wsSendRecipe
} from './recipe-manifests.ts';

/** The simulated ACK test's steps besides its run's passed wait: opening three agents, artifacts and the panel. */
export const SIMULATED_ACK_STEPS_TIMEOUT_MS = 75_000;

/** The simulated failure test bounds each of its runs by an explicit state wait of its own. */
export const SIMULATED_FAILURES_TEST_TIMEOUT_MS = 180_000;

/**
 * The live test's steps besides its runs' passed waits: opening and configuring three agents, membership, each run's
 * staging, the message and diagnostic reads, artifacts and the panel.
 */
export const LIVE_RECIPES_STEPS_TIMEOUT_MS = 150_000;

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
    const { suffix, controlRunId, group, agentIds } = input;
    const everyAgent = { mode: 'selected-agents', agentIds, expectedParticipantCount: agentIds.length } as const;
    const senderOnly = { mode: 'role-map', roles: { sender: [agentIds[0]] }, expectedParticipantCount: 1 } as const;

    const ackRecipe = healthRecipe(`live-ack-${suffix}`);
    const wsTypeId = `room.rallar-black-box.distributed.ws.${suffix}`;
    const wsPrimerRecipe = wsSendRecipe(`live-ws-primer-${suffix}`, group, {
        typeId: wsTypeId,
        topicId: wsTypeId,
        messageId: `ws-primer-${suffix}`,
        role: 'primer'
    });
    const wsMessageId = `ws-sender-receiver-${suffix}`;
    const wsDistributedRunId = `dist-live-ws-send-${suffix}`;
    const wsSenderRecipe = wsSendRecipe(`live-ws-sender-${suffix}`, group, {
        typeId: wsTypeId,
        topicId: wsTypeId,
        messageId: wsMessageId,
        role: 'sender',
        distributedRunId: wsDistributedRunId
    });
    const rtcConnect = rtcConnectRecipe(`live-rtc-connect-${suffix}`, group);
    const rtcMessageId = `rtc-broadcast-${suffix}`;
    const rtcDistributedRunId = `dist-live-rtc-send-${suffix}`;
    const rtcSender = rtcSendRecipe({
        recipeId: `live-rtc-send-${suffix}`,
        group,
        messageId: rtcMessageId,
        distributedRunId: rtcDistributedRunId
    });
    const realtimeDistributedRunId = `dist-live-rtc-realtime-${suffix}`;
    const realtimeConnection = `realtime-${realtimeDistributedRunId}`;
    const realtimeRecipe = createPreprovisionedRealtimeRecipe({
        recipeId: `live-rtc-realtime-${suffix}`,
        group,
        distributedRunId: realtimeDistributedRunId,
        connection: realtimeConnection
    });

    return {
        ack: createDistributedManifest({
            distributedRunId: `dist-live-ack-${suffix}`,
            controlRunId,
            group,
            recipes: [{ recipeId: ackRecipe.recipeId, recipe: ackRecipe, profile: 'live', variables: {} }],
            targetPolicy: { mode: 'all-online-group-members', expectedParticipantCount: agentIds.length }
        }),
        wsPrimer: createDistributedManifest({
            distributedRunId: `dist-live-ws-primer-${suffix}`,
            controlRunId,
            group,
            recipes: [{ recipeId: wsPrimerRecipe.recipeId, recipe: wsPrimerRecipe, profile: 'live-ws', variables: {} }],
            targetPolicy: everyAgent
        }),
        wsSend: createDistributedManifest({
            distributedRunId: wsDistributedRunId,
            controlRunId,
            group,
            recipes: [{
                recipeId: wsSenderRecipe.recipeId,
                role: 'sender',
                recipe: wsSenderRecipe,
                profile: 'live-ws',
                variables: {}
            }],
            targetPolicy: senderOnly
        }),
        wsMessageId,
        rtcConnect: createDistributedManifest({
            distributedRunId: `dist-live-rtc-connect-${suffix}`,
            controlRunId,
            group,
            recipes: [{ recipeId: rtcConnect.recipeId, recipe: rtcConnect, profile: 'live-rtc', variables: {} }],
            targetPolicy: everyAgent
        }),
        rtcSend: createDistributedManifest({
            distributedRunId: rtcDistributedRunId,
            controlRunId,
            group,
            recipes: [{
                recipeId: rtcSender.recipeId,
                role: 'sender',
                recipe: rtcSender,
                profile: 'live-rtc',
                variables: {}
            }],
            targetPolicy: senderOnly
        }),
        rtcMessageId,
        realtime: createDistributedManifest({
            distributedRunId: realtimeDistributedRunId,
            controlRunId,
            group,
            recipes: [{
                recipeId: realtimeRecipe.recipeId,
                recipe: realtimeRecipe,
                profile: 'live-rtc-realtime',
                variables: {}
            }],
            targetPolicy: everyAgent
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
