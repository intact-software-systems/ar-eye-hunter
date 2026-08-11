import type {
    RallarBlackBoxTestRecipe,
} from '../types.ts';

import type {
    RallarBlackBoxCompositeConformanceCaseId,
    RallarBlackBoxCompositeConformanceRecipeOptions,
} from '../composite-conformance.ts';
import {
    closeCommand,
    commandMetadata,
    configureCommand,
    DEFAULT_CONNECTION,
    DEFAULT_ROOM_ID,
    DEFAULT_WS_CONNECTION,
    recipeId,
    recipeMetadata,
    rtcConnectCommand,
    scopeFields,
    statsCommand,
    timeoutMs,
} from './composite-conformance-command-fixtures.ts';
import {
    waitAbsenceHoldRecipe,
    waitAbsenceViolatedRecipe,
} from '../wait/wait-absence-conformance-recipes.ts';

export function createRallarBlackBoxCompositeConformanceRecipe(
    caseId: RallarBlackBoxCompositeConformanceCaseId,
    options: RallarBlackBoxCompositeConformanceRecipeOptions = {},
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
        case 'negative-no-peer':
            return negativeNoPeerRecipe(options);
    }
}

function loopedRtcRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions,
): RallarBlackBoxTestRecipe {
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const roomId = options.roomId ?? DEFAULT_ROOM_ID;
    const transport = options.transport ?? 'realtime';
    return {
        recipeId: recipeId('looped-rtc-send', options),
        name: 'Composite conformance: looped RTC send',
        continueOnFailure: false,
        metadata: recipeMetadata('looped-rtc-send'),
        commands: [
            configureCommand('looped-rtc-send', options),
            rtcConnectCommand(
                'looped-rtc-send',
                'looped-rtc-send-connect',
                connection,
                roomId,
                transport,
                options,
            ),
            {
                kind: 'loop',
                commandId: 'looped-rtc-send-loop',
                count: 3,
                intervalMs: 10,
                thresholds: {
                    minSendSuccessRatio: 1,
                    maxStartDriftMs: 1_000,
                },
                metadata: commandMetadata('looped-rtc-send', 'looped-rtc-send-loop'),
                commands: [
                    {
                        kind: 'rtc.send',
                        commandId: 'looped-rtc-send-frame',
                        connection,
                        transport,
                        timeoutMs: timeoutMs(options),
                        send: {
                            data: {
                                topic: 'rallar.conformance.looped-rtc-send',
                                frame: '{loop.index}',
                                iteration: '{loop.iteration}',
                                elapsedMs: '{loop.elapsedMs}',
                            },
                            roomId,
                            ...scopeFields(options),
                        },
                        metadata: commandMetadata('looped-rtc-send', 'looped-rtc-send-frame'),
                    },
                ],
            },
            statsCommand('looped-rtc-send-stats', 'looped-rtc-send'),
            closeCommand('looped-rtc-send-close', 'looped-rtc-send'),
        ],
    };
}

function parallelWsRtcRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions,
): RallarBlackBoxTestRecipe {
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const wsConnection = options.wsConnection ?? DEFAULT_WS_CONNECTION;
    const roomId = options.roomId ?? DEFAULT_ROOM_ID;
    const transport = options.transport ?? 'messages.rtc';
    return {
        recipeId: recipeId('parallel-ws-rtc-groups', options),
        name: 'Composite conformance: parallel WS and RTC groups',
        continueOnFailure: false,
        metadata: recipeMetadata('parallel-ws-rtc-groups'),
        commands: [
            configureCommand('parallel-ws-rtc-groups', options),
            {
                kind: 'ws.open',
                commandId: 'parallel-ws-open',
                connection: wsConnection,
                url: '{config.wsBaseUrl}/api/ws',
                timeoutMs: timeoutMs(options),
                metadata: commandMetadata('parallel-ws-rtc-groups', 'parallel-ws-open'),
            },
            rtcConnectCommand(
                'parallel-ws-rtc-groups',
                'parallel-rtc-connect',
                connection,
                roomId,
                transport,
                options,
            ),
            {
                kind: 'parallel',
                commandId: 'parallel-ws-rtc',
                maxConcurrency: 2,
                groups: [
                    {
                        groupId: 'ws',
                        commands: [
                            {
                                kind: 'ws.send',
                                commandId: 'parallel-ws-send',
                                connection: wsConnection,
                                data: {
                                    topic: 'rallar.conformance.parallel.ws',
                                    payload: {
                                        source: 'ws',
                                    },
                                },
                                metadata: commandMetadata(
                                    'parallel-ws-rtc-groups',
                                    'parallel-ws-send',
                                ),
                            },
                        ],
                    },
                    {
                        groupId: 'rtc',
                        commands: [
                            {
                                kind: 'rtc.send',
                                commandId: 'parallel-rtc-send',
                                connection,
                                transport,
                                timeoutMs: timeoutMs(options),
                                send: {
                                    payload: {
                                        topic: 'rallar.conformance.parallel.rtc',
                                        source: 'rtc',
                                    },
                                    roomId,
                                    ...scopeFields(options),
                                },
                                metadata: commandMetadata(
                                    'parallel-ws-rtc-groups',
                                    'parallel-rtc-send',
                                ),
                            },
                        ],
                    },
                ],
                metadata: commandMetadata('parallel-ws-rtc-groups', 'parallel-ws-rtc'),
            },
            statsCommand('parallel-ws-rtc-stats', 'parallel-ws-rtc-groups'),
            {
                kind: 'ws.close',
                commandId: 'parallel-ws-close',
                connection: wsConnection,
                code: 1000,
                reason: 'conformance complete',
                metadata: commandMetadata('parallel-ws-rtc-groups', 'parallel-ws-close'),
            },
            closeCommand('parallel-close', 'parallel-ws-rtc-groups'),
        ],
    };
}

function waitAssertRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions,
): RallarBlackBoxTestRecipe {
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const roomId = options.roomId ?? DEFAULT_ROOM_ID;
    const transport = options.transport ?? 'realtime';
    return {
        recipeId: recipeId('wait-assert-evidence', options),
        name: 'Composite conformance: wait and assert evidence',
        continueOnFailure: false,
        metadata: recipeMetadata('wait-assert-evidence'),
        commands: [
            configureCommand('wait-assert-evidence', options),
            rtcConnectCommand(
                'wait-assert-evidence',
                'wait-assert-connect',
                connection,
                roomId,
                transport,
                options,
            ),
            {
                kind: 'rtc.send',
                commandId: 'wait-assert-send',
                connection,
                transport,
                timeoutMs: timeoutMs(options),
                send: {
                    data: {
                        topic: 'rallar.conformance.wait-assert',
                        marker: 'wait-assert-evidence',
                    },
                    roomId,
                    ...scopeFields(options),
                },
                metadata: commandMetadata('wait-assert-evidence', 'wait-assert-send'),
            },
            {
                kind: 'wait',
                commandId: 'wait-assert-wait-message',
                timeoutMs: timeoutMs(options),
                match: {
                    kind: 'message',
                    topic: 'rallar.conformance.message',
                    payloadPath: 'data.topic',
                    equals: 'rallar.conformance.wait-assert',
                },
                metadata: commandMetadata('wait-assert-evidence', 'wait-assert-wait-message'),
            },
            {
                kind: 'assert',
                commandId: 'wait-assert-check-message',
                source: 'messages.0.payload.data.marker',
                operator: 'equals',
                expected: 'wait-assert-evidence',
                metadata: commandMetadata('wait-assert-evidence', 'wait-assert-check-message'),
            },
            statsCommand('wait-assert-stats', 'wait-assert-evidence'),
            closeCommand('wait-assert-close', 'wait-assert-evidence'),
        ],
    };
}

function cancelDuringLoopRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions,
): RallarBlackBoxTestRecipe {
    return {
        recipeId: recipeId('cancel-during-loop', options),
        name: 'Composite conformance: cancellation during loop',
        continueOnFailure: false,
        metadata: recipeMetadata('cancel-during-loop'),
        commands: [
            configureCommand('cancel-during-loop', options),
            {
                kind: 'loop',
                commandId: 'cancel-during-loop-loop',
                count: 3,
                intervalMs: 10,
                metadata: commandMetadata('cancel-during-loop', 'cancel-during-loop-loop'),
                commands: [
                    {
                        kind: 'health',
                        commandId: 'cancel-loop-health',
                        metadata: commandMetadata('cancel-during-loop', 'cancel-loop-health'),
                    },
                    {
                        kind: 'recipe.cancel',
                        commandId: 'cancel-loop-request',
                        reason: 'composite conformance cancellation case',
                        metadata: commandMetadata('cancel-during-loop', 'cancel-loop-request'),
                    },
                ],
            },
            statsCommand('cancel-during-loop-stats', 'cancel-during-loop'),
        ],
    };
}

function negativeNoPeerRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions,
): RallarBlackBoxTestRecipe {
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const roomId = options.roomId ?? DEFAULT_ROOM_ID;
    const transport = options.transport ?? 'realtime';
    return {
        recipeId: recipeId('negative-no-peer', options),
        name: 'Composite conformance: no-peer negative case',
        continueOnFailure: false,
        metadata: recipeMetadata('negative-no-peer'),
        commands: [
            configureCommand('negative-no-peer', options),
            rtcConnectCommand(
                'negative-no-peer',
                'negative-no-peer-connect',
                connection,
                roomId,
                transport,
                options,
            ),
            {
                kind: 'rtc.send',
                commandId: 'negative-no-peer-send',
                connection,
                transport,
                timeoutMs: timeoutMs(options),
                send: {
                    data: {
                        topic: 'rallar.conformance.negative-no-peer',
                        marker: 'negative-no-peer',
                    },
                    roomId,
                    peerIds: ['missing-peer'],
                    ...scopeFields(options),
                },
                metadata: commandMetadata('negative-no-peer', 'negative-no-peer-send'),
            },
            statsCommand('negative-no-peer-stats', 'negative-no-peer'),
        ],
    };
}
