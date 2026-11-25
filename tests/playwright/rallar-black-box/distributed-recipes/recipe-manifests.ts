import {
    type RallarBlackBoxDistributedGroupRef,
    type RallarBlackBoxDistributedRunManifest
} from '../../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import {
    RALLAR_BLACK_BOX_RTC_CONNECT_ESTABLISHMENT_TIMEOUT_MS,
    RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS
} from '../../../../packages/shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';
import { createRallarBlackBoxRtcRealtimeRecipe } from '../../../../packages/shared-test/rallar-bb-test/fixtures/rtc-realtime-recipes.ts';
import { type RallarBlackBoxTestRecipe } from '../../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_RECIPE_FIXTURES } from '../../../../packages/shared-test/rallar-bb-test/recipe-fixtures.ts';
import { decodeRecord } from '../../../../packages/shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';

import { config } from './browser-agents.ts';

// The recipes' budgets are counted from the recipes themselves by the distributed run's terminal timeout.

/** The WS send recipe's budget for its send. */
const WS_SEND_RECIPE_TIMEOUT_MS = 45_000;

/** How long the RTC connect recipe waits for its two peers to be ready. */
const RTC_CONNECT_RECIPE_READINESS_TIMEOUT_MS = 30_000;

/** The RTC send recipe's budget for its broadcast, and how long that send may take to open its data channel. */
const RTC_SEND_RECIPE_TIMEOUT_MS = 60_000;
const RTC_SEND_RECIPE_OPEN_TIMEOUT_MS = 20_000;

/** How long a distributed run waits for its targets to acknowledge a phase, unless its manifest names its own. */
const DISTRIBUTED_MANIFEST_ACK_TIMEOUT_MS = 10_000;

/** How long the preprovisioned realtime recipe waits for its peers to be ready. */
const REALTIME_RECIPE_READY_TIMEOUT_MS = 5_000;

interface RtcSendRecipeInput {
    readonly recipeId: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly messageId: string;
    readonly distributedRunId?: string;
}

interface DistributedManifestInput {
    readonly distributedRunId: string;
    readonly controlRunId: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly recipes: RallarBlackBoxDistributedRunManifest['recipes'];
    readonly targetPolicy: RallarBlackBoxDistributedRunManifest['targetPolicy'];
    readonly roleAssignments?: RallarBlackBoxDistributedRunManifest['roleAssignments'];
    readonly ackTimeoutMs?: number;
    readonly displayName?: string;
}

interface WsSendRecipeInput {
    readonly typeId: string;
    readonly topicId: string;
    readonly messageId: string;
    readonly role: string;
    readonly distributedRunId?: string;
}

interface PreprovisionedRealtimeRecipeInput {
    readonly recipeId: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly distributedRunId: string;
    readonly connection: string;
}

export function healthRecipe(recipeId: string): RallarBlackBoxTestRecipe {
    return {
        schemaVersion: 1,
        recipeId,
        name: recipeId,
        commands: [{
            kind: 'health',
            commandId: `${recipeId}-health`
        }]
    };
}

export function compositeEvidenceRecipe(recipeId: string): RallarBlackBoxTestRecipe {
    const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find((entry) => entry.fixtureId === 'composite-evidence');
    if (!fixture) {
        throw new Error('Missing required composite-evidence recipe fixture.');
    }

    return {
        ...fixture.recipe,
        recipeId,
        name: recipeId
    };
}

export function createDistributedManifest(
    input: DistributedManifestInput
): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        displayName: input.displayName ?? input.distributedRunId,
        group: input.group,
        recipes: input.recipes,
        targetPolicy: input.targetPolicy,
        variables: {},
        roleAssignments: input.roleAssignments ?? [],
        ackTimeoutMs: input.ackTimeoutMs ?? DISTRIBUTED_MANIFEST_ACK_TIMEOUT_MS,
        barrier: { enabled: false },
        startMode: 'manual',
        groupAssertions: [],
        metadata: {
            source: 'full-stack-distributed-recipes'
        }
    };
}

export function wsSendRecipe(
    recipeId: string,
    group: RallarBlackBoxDistributedGroupRef,
    input: WsSendRecipeInput
): RallarBlackBoxTestRecipe {
    return {
        schemaVersion: 1,
        recipeId,
        commands: [{
            kind: 'ws.send',
            commandId: `${recipeId}-send`,
            connection: `ws-${input.role}`,
            data: {
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                roomId: group.groupId,
                roomRef: group,
                typeId: input.typeId,
                topicId: input.topicId,
                contextId: group.groupId,
                resourceId: `${input.messageId}-{auth.clientId}`,
                payload: {
                    distributedRunId: input.distributedRunId,
                    messageId: input.messageId,
                    role: input.role,
                    from: '{auth.clientId}'
                }
            },
            timeoutMs: WS_SEND_RECIPE_TIMEOUT_MS
        }]
    };
}

export function rtcConnectRecipe(
    recipeId: string,
    group: RallarBlackBoxDistributedGroupRef
): RallarBlackBoxTestRecipe {
    return {
        schemaVersion: 1,
        recipeId,
        commands: [{
            kind: 'rtc.connect',
            commandId: `${recipeId}-connect`,
            connection: 'distributed-rtc',
            actor: '{auth.clientId}',
            roomId: group.groupId,
            applicationId: group.applicationId,
            workspaceId: group.workspaceId,
            roomRef: group,
            transport: 'realtime',
            readiness: { minReadyPeers: 2, timeoutMs: RTC_CONNECT_RECIPE_READINESS_TIMEOUT_MS, intervalMs: 100 },
            rallar: {
                apiBaseUrl: config.apiBaseUrl,
                restoreSession: true,
                logoutOnClose: false,
                leaveRoomOnClose: false,
                timeoutMs: RALLAR_BLACK_BOX_RTC_CONNECT_ESTABLISHMENT_TIMEOUT_MS
            },
            timeoutMs: RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS
        }]
    };
}

export function rtcSendRecipe(input: RtcSendRecipeInput): RallarBlackBoxTestRecipe {
    const { recipeId, group, messageId, distributedRunId } = input;

    return {
        schemaVersion: 1,
        recipeId,
        commands: [{
            kind: 'rtc.send',
            commandId: `${recipeId}-send`,
            connection: 'distributed-rtc',
            transport: 'realtime',
            applicationId: group.applicationId,
            workspaceId: group.workspaceId,
            roomRef: group,
            send: {
                roomId: group.groupId,
                openTimeoutMs: RTC_SEND_RECIPE_OPEN_TIMEOUT_MS,
                data: {
                    topic: 'rallar.black-box.distributed.recipe.qa',
                    distributedRunId,
                    messageId,
                    deliveryMode: 'broadcast',
                    transport: 'realtime',
                    groupId: group.groupId
                }
            },
            timeoutMs: RTC_SEND_RECIPE_TIMEOUT_MS
        }]
    };
}

export function createPreprovisionedRealtimeRecipe(input: PreprovisionedRealtimeRecipeInput): RallarBlackBoxTestRecipe {
    const { recipeId, group, distributedRunId, connection } = input;
    const base = createRallarBlackBoxRtcRealtimeRecipe({
        durationSeconds: 1,
        connection,
        group,
        readyPeerCount: 2,
        readyTimeoutMs: REALTIME_RECIPE_READY_TIMEOUT_MS
    });
    return {
        ...base,
        recipeId,
        name: recipeId,
        // Group creation and every membership are already proved before this workload.
        commands: base.commands.filter((command) =>
            command.commandId !== 'rtc-realtime-ensure-group' && command.commandId !== 'rtc-realtime-ensure-member'
        ).map((command) => {
            if (command.kind !== 'loop') {
                return command;
            }
            return {
                ...command,
                commands: command.commands.map((child) => {
                    if (child.kind !== 'rtc.send') {
                        return child;
                    }
                    const send = decodeRecord(child.send);
                    const data = decodeRecord(send.data);
                    return {
                        ...child,
                        send: {
                            ...send,
                            data: {
                                ...data,
                                distributedRunId,
                                messageId: `rtc-realtime-${distributedRunId}`
                            }
                        }
                    };
                })
            };
        })
    };
}
