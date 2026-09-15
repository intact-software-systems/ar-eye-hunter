import type { RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';

import type { RallarBlackBoxCompositeConformanceRecipeOptions } from '../composite-conformance.ts';
import {
    DEFAULT_CONNECTION,
    DEFAULT_ROOM_ID,
    toCommandMetadata,
    toConfigureCommand,
    toConformanceMessageProbe,
    toConformanceMessageWait,
    toRecipeId,
    toRecipeMetadata,
    toRtcConnectCommand,
    toTimeoutMs
} from '../conformance/composite-conformance-command-fixtures.ts';

export function assertShapeCompleteViolatedRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const roomId = options.roomId ?? DEFAULT_ROOM_ID;
    const transport = options.transport ?? 'realtime';
    return {
        schemaVersion: 1,
        recipeId: toRecipeId('assert-shape-complete-violated', options),
        name: 'Composite conformance: assert shape complete violated control',
        continueOnFailure: false,
        metadata: toRecipeMetadata('assert-shape-complete-violated'),
        commands: [
            toConfigureCommand('assert-shape-complete-violated', options),
            toRtcConnectCommand({
                caseId: 'assert-shape-complete-violated',
                commandId: 'assert-shape-violated-connect',
                connection: connection,
                roomId: roomId,
                transport: transport,
                options: options
            }),
            toConformanceMessageProbe({
                options,
                caseId: 'assert-shape-complete-violated',
                commandId: 'assert-shape-violated-send',
                connection,
                roomId,
                transport,
                data: {
                    topic: 'rallar.conformance.assert-shape',
                    items: ['expected-item', 'unexpected-item']
                }
            }),
            toConformanceMessageWait({
                commandId: 'assert-shape-violated-wait',
                timeoutMs: toTimeoutMs(options),
                topic: 'rallar.conformance.assert-shape',
                caseId: 'assert-shape-complete-violated'
            }),
            {
                kind: 'assert',
                commandId: 'assert-shape-violated-complete',
                source: 'messages.0.payload.data',
                operator: 'matchesShapeComplete',
                expected: {
                    topic: 'rallar.conformance.assert-shape',
                    items: ['expected-item']
                },
                metadata: toCommandMetadata(
                    'assert-shape-complete-violated',
                    'assert-shape-violated-complete'
                )
            }
        ]
    };
}
