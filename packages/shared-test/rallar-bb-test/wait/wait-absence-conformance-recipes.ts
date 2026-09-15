import type { RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';

import type { RallarBlackBoxCompositeConformanceRecipeOptions } from '../composite-conformance.ts';
import {
    DEFAULT_CONNECTION,
    DEFAULT_ROOM_ID,
    toCloseCommand,
    toConfigureCommand,
    toConformanceMessageProbe,
    toConformanceMessageWait,
    toRecipeId,
    toRecipeMetadata,
    toRtcConnectCommand,
    toStatsCommand,
    toTimeoutMs
} from '../conformance/composite-conformance-command-fixtures.ts';

export function waitAbsenceHoldRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const roomId = options.roomId ?? DEFAULT_ROOM_ID;
    const transport = options.transport ?? 'realtime';
    return {
        schemaVersion: 1,
        recipeId: toRecipeId('wait-absence-hold', options),
        name: 'Composite conformance: wait absence holds',
        continueOnFailure: false,
        metadata: toRecipeMetadata('wait-absence-hold'),
        commands: [
            toConfigureCommand('wait-absence-hold', options),
            toRtcConnectCommand({
                caseId: 'wait-absence-hold',
                commandId: 'wait-absence-hold-connect',
                connection: connection,
                roomId: roomId,
                transport: transport,
                options: options
            }),
            toConformanceMessageProbe({
                options,
                caseId: 'wait-absence-hold',
                commandId: 'wait-absence-hold-send',
                connection,
                roomId,
                transport,
                data: {
                    topic: 'rallar.conformance.wait-absence-hold',
                    marker: 'wait-absence-hold'
                }
            }),
            toConformanceMessageWait({
                commandId: 'wait-absence-hold-positive-control',
                timeoutMs: toTimeoutMs(options),
                topic: 'rallar.conformance.wait-absence-hold',
                caseId: 'wait-absence-hold'
            }),
            toConformanceMessageWait({
                commandId: 'wait-absence-hold-absent',
                timeoutMs: 1_500,
                absent: true,
                topic: 'rallar.conformance.wait-absence-other-room',
                caseId: 'wait-absence-hold'
            }),
            toStatsCommand('wait-absence-hold-stats', 'wait-absence-hold'),
            toCloseCommand('wait-absence-hold-close', 'wait-absence-hold')
        ]
    };
}

export function waitAbsenceViolatedRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const roomId = options.roomId ?? DEFAULT_ROOM_ID;
    const transport = options.transport ?? 'realtime';
    return {
        schemaVersion: 1,
        recipeId: toRecipeId('wait-absence-violated', options),
        name: 'Composite conformance: wait absence violated control',
        continueOnFailure: false,
        metadata: toRecipeMetadata('wait-absence-violated'),
        commands: [
            toConfigureCommand('wait-absence-violated', options),
            toRtcConnectCommand({
                caseId: 'wait-absence-violated',
                commandId: 'wait-absence-violated-connect',
                connection: connection,
                roomId: roomId,
                transport: transport,
                options: options
            }),
            toConformanceMessageProbe({
                options,
                caseId: 'wait-absence-violated',
                commandId: 'wait-absence-violated-send',
                connection,
                roomId,
                transport,
                data: {
                    topic: 'rallar.conformance.wait-absence-violated',
                    marker: 'wait-absence-violated'
                }
            }),
            toConformanceMessageWait({
                commandId: 'wait-absence-violated-positive-control',
                timeoutMs: toTimeoutMs(options),
                topic: 'rallar.conformance.wait-absence-violated',
                caseId: 'wait-absence-violated'
            }),
            toConformanceMessageWait({
                commandId: 'wait-absence-violated-absent',
                timeoutMs: 1_500,
                absent: true,
                topic: 'rallar.conformance.wait-absence-violated',
                caseId: 'wait-absence-violated'
            })
        ]
    };
}
