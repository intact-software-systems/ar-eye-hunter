import type { RallarBlackBoxTestRecipe } from '../types.ts';

import type { RallarBlackBoxCompositeConformanceRecipeOptions } from '../composite-conformance.ts';
import {
    commandMetadata,
    configureCommand,
    DEFAULT_CONNECTION,
    DEFAULT_ROOM_ID,
    recipeId,
    recipeMetadata,
    rtcConnectCommand,
    scopeFields,
    timeoutMs
} from '../conformance/composite-conformance-command-fixtures.ts';

export function assertShapeCompleteViolatedRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const roomId = options.roomId ?? DEFAULT_ROOM_ID;
    const transport = options.transport ?? 'realtime';
    return {
        recipeId: recipeId('assert-shape-complete-violated', options),
        name: 'Composite conformance: assert shape complete violated control',
        continueOnFailure: false,
        metadata: recipeMetadata('assert-shape-complete-violated'),
        commands: [
            configureCommand('assert-shape-complete-violated', options),
            rtcConnectCommand(
                'assert-shape-complete-violated',
                'assert-shape-violated-connect',
                connection,
                roomId,
                transport,
                options
            ),
            {
                kind: 'rtc.send',
                commandId: 'assert-shape-violated-send',
                connection,
                transport,
                timeoutMs: timeoutMs(options),
                send: {
                    data: {
                        topic: 'rallar.conformance.assert-shape',
                        items: ['expected-item', 'unexpected-item']
                    },
                    roomId,
                    ...scopeFields(options)
                },
                metadata: commandMetadata(
                    'assert-shape-complete-violated',
                    'assert-shape-violated-send'
                )
            },
            {
                kind: 'wait',
                commandId: 'assert-shape-violated-wait',
                timeoutMs: timeoutMs(options),
                match: {
                    kind: 'message',
                    topic: 'rallar.conformance.message',
                    payloadPath: 'data.topic',
                    equals: 'rallar.conformance.assert-shape'
                },
                metadata: commandMetadata(
                    'assert-shape-complete-violated',
                    'assert-shape-violated-wait'
                )
            },
            {
                kind: 'assert',
                commandId: 'assert-shape-violated-complete',
                source: 'messages.0.payload.data',
                operator: 'matchesShapeComplete',
                expected: {
                    topic: 'rallar.conformance.assert-shape',
                    items: ['expected-item']
                },
                metadata: commandMetadata(
                    'assert-shape-complete-violated',
                    'assert-shape-violated-complete'
                )
            }
        ]
    };
}
