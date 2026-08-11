import type {
    RallarBlackBoxTestRecipe,
} from '../types.ts';

import type {
    RallarBlackBoxCompositeConformanceRecipeOptions,
} from '../composite-conformance.ts';
import {
    closeCommand,
    commandMetadata,
    configureCommand,
    DEFAULT_CONNECTION,
    DEFAULT_ROOM_ID,
    recipeId,
    recipeMetadata,
    rtcConnectCommand,
    scopeFields,
    statsCommand,
    timeoutMs,
} from '../conformance/composite-conformance-command-fixtures.ts';

export function waitAbsenceHoldRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions,
): RallarBlackBoxTestRecipe {
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const roomId = options.roomId ?? DEFAULT_ROOM_ID;
    const transport = options.transport ?? 'realtime';
    return {
        recipeId: recipeId('wait-absence-hold', options),
        name: 'Composite conformance: wait absence holds',
        continueOnFailure: false,
        metadata: recipeMetadata('wait-absence-hold'),
        commands: [
            configureCommand('wait-absence-hold', options),
            rtcConnectCommand(
                'wait-absence-hold',
                'wait-absence-hold-connect',
                connection,
                roomId,
                transport,
                options,
            ),
            {
                kind: 'rtc.send',
                commandId: 'wait-absence-hold-send',
                connection,
                transport,
                timeoutMs: timeoutMs(options),
                send: {
                    data: {
                        topic: 'rallar.conformance.wait-absence-hold',
                        marker: 'wait-absence-hold',
                    },
                    roomId,
                    ...scopeFields(options),
                },
                metadata: commandMetadata('wait-absence-hold', 'wait-absence-hold-send'),
            },
            {
                kind: 'wait',
                commandId: 'wait-absence-hold-positive-control',
                timeoutMs: timeoutMs(options),
                match: {
                    kind: 'message',
                    topic: 'rallar.conformance.message',
                    payloadPath: 'data.topic',
                    equals: 'rallar.conformance.wait-absence-hold',
                },
                metadata: commandMetadata(
                    'wait-absence-hold',
                    'wait-absence-hold-positive-control',
                ),
            },
            {
                kind: 'wait',
                commandId: 'wait-absence-hold-absent',
                absent: true,
                timeoutMs: 1_500,
                match: {
                    kind: 'message',
                    topic: 'rallar.conformance.message',
                    payloadPath: 'data.topic',
                    equals: 'rallar.conformance.wait-absence-other-room',
                },
                metadata: commandMetadata('wait-absence-hold', 'wait-absence-hold-absent'),
            },
            statsCommand('wait-absence-hold-stats', 'wait-absence-hold'),
            closeCommand('wait-absence-hold-close', 'wait-absence-hold'),
        ],
    };
}

export function waitAbsenceViolatedRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions,
): RallarBlackBoxTestRecipe {
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const roomId = options.roomId ?? DEFAULT_ROOM_ID;
    const transport = options.transport ?? 'realtime';
    return {
        recipeId: recipeId('wait-absence-violated', options),
        name: 'Composite conformance: wait absence violated control',
        continueOnFailure: false,
        metadata: recipeMetadata('wait-absence-violated'),
        commands: [
            configureCommand('wait-absence-violated', options),
            rtcConnectCommand(
                'wait-absence-violated',
                'wait-absence-violated-connect',
                connection,
                roomId,
                transport,
                options,
            ),
            {
                kind: 'rtc.send',
                commandId: 'wait-absence-violated-send',
                connection,
                transport,
                timeoutMs: timeoutMs(options),
                send: {
                    data: {
                        topic: 'rallar.conformance.wait-absence-violated',
                        marker: 'wait-absence-violated',
                    },
                    roomId,
                    ...scopeFields(options),
                },
                metadata: commandMetadata('wait-absence-violated', 'wait-absence-violated-send'),
            },
            {
                kind: 'wait',
                commandId: 'wait-absence-violated-positive-control',
                timeoutMs: timeoutMs(options),
                match: {
                    kind: 'message',
                    topic: 'rallar.conformance.message',
                    payloadPath: 'data.topic',
                    equals: 'rallar.conformance.wait-absence-violated',
                },
                metadata: commandMetadata(
                    'wait-absence-violated',
                    'wait-absence-violated-positive-control',
                ),
            },
            {
                kind: 'wait',
                commandId: 'wait-absence-violated-absent',
                absent: true,
                timeoutMs: 1_500,
                match: {
                    kind: 'message',
                    topic: 'rallar.conformance.message',
                    payloadPath: 'data.topic',
                    equals: 'rallar.conformance.wait-absence-violated',
                },
                metadata: commandMetadata('wait-absence-violated', 'wait-absence-violated-absent'),
            },
        ],
    };
}
