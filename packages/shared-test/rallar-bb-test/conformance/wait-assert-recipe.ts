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
} from './composite-conformance-command-fixtures.ts';

export function waitAssertRecipe(
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
            {
                kind: 'assert',
                commandId: 'wait-assert-check-gt',
                source: 'state.messages.length',
                operator: 'gt',
                expected: 0,
                metadata: commandMetadata('wait-assert-evidence', 'wait-assert-check-gt'),
            },
            {
                kind: 'assert',
                commandId: 'wait-assert-check-between',
                source: 'state.messages.length',
                operator: 'between',
                expected: [1, 50],
                metadata: commandMetadata('wait-assert-evidence', 'wait-assert-check-between'),
            },
            {
                kind: 'assert',
                commandId: 'wait-assert-check-marker-length',
                source: 'messages.0.payload.data.marker',
                operator: 'length',
                expected: 'wait-assert-evidence'.length,
                metadata: commandMetadata(
                    'wait-assert-evidence',
                    'wait-assert-check-marker-length',
                ),
            },
            {
                kind: 'assert',
                commandId: 'wait-assert-check-topic-pattern',
                source: 'messages.0.payload.data.topic',
                operator: 'matches',
                expected: '^rallar\\.conformance\\.',
                metadata: commandMetadata(
                    'wait-assert-evidence',
                    'wait-assert-check-topic-pattern',
                ),
            },
            {
                kind: 'assert',
                commandId: 'wait-assert-check-shape',
                source: 'messages.0.payload',
                operator: 'matchesShape',
                expected: {
                    data: {
                        marker: 'wait-assert-evidence',
                    },
                },
                metadata: commandMetadata('wait-assert-evidence', 'wait-assert-check-shape'),
            },
            statsCommand('wait-assert-stats', 'wait-assert-evidence'),
            closeCommand('wait-assert-close', 'wait-assert-evidence'),
        ],
    };
}
