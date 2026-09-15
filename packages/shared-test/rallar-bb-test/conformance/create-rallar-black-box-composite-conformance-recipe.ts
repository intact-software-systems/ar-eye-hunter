import type { RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';

import { assertShapeCompleteViolatedRecipe } from '../assert/assert-shape-complete-violated-recipe.ts';
import type {
    RallarBlackBoxCompositeConformanceCaseId,
    RallarBlackBoxCompositeConformanceRecipeOptions
} from '../composite-conformance.ts';
import { loopUntilConvergenceRecipe, loopUntilExhaustedRecipe } from '../loop/loop-until-conformance-recipes.ts';
import type { RallarBlackBoxTestCommand } from '../rallar-black-box-test-contracts.ts';
import { waitAbsenceHoldRecipe, waitAbsenceViolatedRecipe } from '../wait/wait-absence-conformance-recipes.ts';
import {
    DEFAULT_CONNECTION,
    DEFAULT_ROOM_ID,
    DEFAULT_WS_CONNECTION,
    toCloseCommand,
    toCommandMetadata,
    toConfigureCommand,
    toRecipeId,
    toRecipeMetadata,
    toRtcConnectCommand,
    toScopeFields,
    toStatsCommand,
    toTimeoutMs
} from './composite-conformance-command-fixtures.ts';
import { waitAssertRecipe } from './wait-assert-recipe.ts';

export function createRallarBlackBoxCompositeConformanceRecipe(
    caseId: RallarBlackBoxCompositeConformanceCaseId,
    options: RallarBlackBoxCompositeConformanceRecipeOptions = {}
): RallarBlackBoxTestRecipe {
    switch (caseId) {
        case 'looped-rtc-send':
            return loopedRtcRecipe(options);
        case 'parallel-ws-rtc-groups':
            return parallelWsRtcRecipe(options);
        case 'wait-assert-evidence':
            return waitAssertRecipe(options);
        case 'cancel-during-loop':
            return cancelDuringLoopRecipe(options);
        case 'wait-absence-hold':
            return waitAbsenceHoldRecipe(options);
        case 'wait-absence-violated':
            return waitAbsenceViolatedRecipe(options);
        case 'assert-shape-complete-violated':
            return assertShapeCompleteViolatedRecipe(options);
        case 'loop-until-convergence':
            return loopUntilConvergenceRecipe(options);
        case 'loop-until-exhausted':
            return loopUntilExhaustedRecipe(options);
        case 'negative-no-peer':
            return negativeNoPeerRecipe(options);
    }
}

function loopedRtcRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const roomId = options.roomId ?? DEFAULT_ROOM_ID;
    const transport = options.transport ?? 'realtime';
    return {
        schemaVersion: 1,
        recipeId: toRecipeId('looped-rtc-send', options),
        name: 'Composite conformance: looped RTC send',
        continueOnFailure: false,
        metadata: toRecipeMetadata('looped-rtc-send'),
        commands: [
            toConfigureCommand('looped-rtc-send', options),
            toRtcConnectCommand({
                caseId: 'looped-rtc-send',
                commandId: 'looped-rtc-send-connect',
                connection: connection,
                roomId: roomId,
                transport: transport,
                options: options
            }),
            {
                kind: 'loop',
                commandId: 'looped-rtc-send-loop',
                count: 3,
                intervalMs: 10,
                thresholds: {
                    minSendSuccessRatio: 1,
                    maxStartDriftMs: 1_000
                },
                metadata: toCommandMetadata('looped-rtc-send', 'looped-rtc-send-loop'),
                commands: [
                    {
                        kind: 'rtc.send',
                        commandId: 'looped-rtc-send-frame',
                        connection,
                        transport,
                        timeoutMs: toTimeoutMs(options),
                        send: {
                            data: {
                                topic: 'rallar.conformance.looped-rtc-send',
                                frame: '{loop.index}',
                                iteration: '{loop.iteration}',
                                elapsedMs: '{loop.elapsedMs}'
                            },
                            roomId,
                            ...toScopeFields(options)
                        },
                        metadata: toCommandMetadata('looped-rtc-send', 'looped-rtc-send-frame')
                    }
                ]
            },
            toStatsCommand('looped-rtc-send-stats', 'looped-rtc-send'),
            toCloseCommand('looped-rtc-send-close', 'looped-rtc-send')
        ]
    };
}

function parallelWsRtcRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const wsConnection = options.wsConnection ?? DEFAULT_WS_CONNECTION;
    const roomId = options.roomId ?? DEFAULT_ROOM_ID;
    const transport = options.transport ?? 'messages.rtc';
    return {
        schemaVersion: 1,
        recipeId: toRecipeId('parallel-ws-rtc-groups', options),
        name: 'Composite conformance: parallel WS and RTC groups',
        continueOnFailure: false,
        metadata: toRecipeMetadata('parallel-ws-rtc-groups'),
        commands: [
            toConfigureCommand('parallel-ws-rtc-groups', options),
            {
                kind: 'ws.open',
                commandId: 'parallel-ws-open',
                connection: wsConnection,
                url: '{config.wsBaseUrl}/api/ws',
                timeoutMs: toTimeoutMs(options),
                metadata: toCommandMetadata('parallel-ws-rtc-groups', 'parallel-ws-open')
            },
            toRtcConnectCommand({
                caseId: 'parallel-ws-rtc-groups',
                commandId: 'parallel-rtc-connect',
                connection: connection,
                roomId: roomId,
                transport: transport,
                options: options
            }),
            toParallelSendCommand({ options, connection, wsConnection, roomId, transport }),
            toStatsCommand('parallel-ws-rtc-stats', 'parallel-ws-rtc-groups'),
            {
                kind: 'ws.close',
                commandId: 'parallel-ws-close',
                connection: wsConnection,
                code: 1000,
                reason: 'conformance complete',
                metadata: toCommandMetadata('parallel-ws-rtc-groups', 'parallel-ws-close')
            },
            toCloseCommand('parallel-close', 'parallel-ws-rtc-groups')
        ]
    };
}

function cancelDuringLoopRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    return {
        schemaVersion: 1,
        recipeId: toRecipeId('cancel-during-loop', options),
        name: 'Composite conformance: cancellation during loop',
        continueOnFailure: false,
        metadata: toRecipeMetadata('cancel-during-loop'),
        commands: [
            toConfigureCommand('cancel-during-loop', options),
            {
                kind: 'loop',
                commandId: 'cancel-during-loop-loop',
                count: 3,
                intervalMs: 10,
                metadata: toCommandMetadata('cancel-during-loop', 'cancel-during-loop-loop'),
                commands: [
                    {
                        kind: 'health',
                        commandId: 'cancel-loop-health',
                        metadata: toCommandMetadata('cancel-during-loop', 'cancel-loop-health')
                    },
                    {
                        kind: 'recipe.cancel',
                        commandId: 'cancel-loop-request',
                        reason: 'composite conformance cancellation case',
                        metadata: toCommandMetadata('cancel-during-loop', 'cancel-loop-request')
                    }
                ]
            },
            toStatsCommand('cancel-during-loop-stats', 'cancel-during-loop')
        ]
    };
}

function negativeNoPeerRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const roomId = options.roomId ?? DEFAULT_ROOM_ID;
    const transport = options.transport ?? 'realtime';
    return {
        schemaVersion: 1,
        recipeId: toRecipeId('negative-no-peer', options),
        name: 'Composite conformance: no-peer negative case',
        continueOnFailure: false,
        metadata: toRecipeMetadata('negative-no-peer'),
        commands: [
            toConfigureCommand('negative-no-peer', options),
            toRtcConnectCommand({
                caseId: 'negative-no-peer',
                commandId: 'negative-no-peer-connect',
                connection: connection,
                roomId: roomId,
                transport: transport,
                options: options
            }),
            {
                kind: 'rtc.send',
                commandId: 'negative-no-peer-send',
                connection,
                transport,
                timeoutMs: toTimeoutMs(options),
                send: {
                    data: {
                        topic: 'rallar.conformance.negative-no-peer',
                        marker: 'negative-no-peer'
                    },
                    roomId,
                    peerIds: ['missing-peer'],
                    ...toScopeFields(options)
                },
                metadata: toCommandMetadata('negative-no-peer', 'negative-no-peer-send')
            },
            toStatsCommand('negative-no-peer-stats', 'negative-no-peer')
        ]
    };
}

interface ParallelConformanceContext {
    readonly options: RallarBlackBoxCompositeConformanceRecipeOptions;
    readonly connection: string;
    readonly wsConnection: string;
    readonly roomId: string;
    readonly transport: 'realtime' | 'messages.rtc';
}

function toParallelWsSend(context: ParallelConformanceContext): RallarBlackBoxTestCommand {
    const { options, connection, wsConnection, roomId, transport } = context;
    return {
        kind: 'ws.send',
        commandId: 'parallel-ws-send',
        connection: wsConnection,
        data: {
            topic: 'rallar.conformance.parallel.ws',
            payload: {
                source: 'ws'
            }
        },
        metadata: toCommandMetadata(
            'parallel-ws-rtc-groups',
            'parallel-ws-send'
        )
    };
}

function toParallelRtcSend(context: ParallelConformanceContext): RallarBlackBoxTestCommand {
    const { options, connection, wsConnection, roomId, transport } = context;
    return {
        kind: 'rtc.send',
        commandId: 'parallel-rtc-send',
        connection,
        transport,
        timeoutMs: toTimeoutMs(options),
        send: {
            payload: {
                topic: 'rallar.conformance.parallel.rtc',
                source: 'rtc'
            },
            roomId,
            ...toScopeFields(options)
        },
        metadata: toCommandMetadata(
            'parallel-ws-rtc-groups',
            'parallel-rtc-send'
        )
    };
}

function toParallelSendCommand(context: ParallelConformanceContext): RallarBlackBoxTestCommand {
    return {
        kind: 'parallel',
        commandId: 'parallel-ws-rtc',
        maxConcurrency: 2,
        groups: [
            {
                groupId: 'ws',
                commands: [
                    toParallelWsSend(context)
                ]
            },
            {
                groupId: 'rtc',
                commands: [
                    toParallelRtcSend(context)
                ]
            }
        ],
        metadata: toCommandMetadata('parallel-ws-rtc-groups', 'parallel-ws-rtc')
    };
}
