import type { RallarBlackBoxCompositeConformanceRecipeOptions } from '../composite-conformance.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';
import {
    toCloseCommand,
    toConfigureCommand,
    toConformanceMessageProbe,
    toConformanceMessageWait,
    toRtcConnectCommand,
    toStatsCommand
} from './composite-conformance-command-fixtures.ts';
import {
    toCommandMetadata,
    toRecipeId,
    toRecipeMetadata
} from './composite-conformance-recipe-values.ts';

export function waitAssertRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    const connection = options.connection;
    const roomId = options.roomId;
    const transport = options.transport ?? 'realtime';
    return {
        schemaVersion: 1,
        recipeId: toRecipeId('wait-assert-evidence', options),
        name: 'Composite conformance: wait and assert evidence',
        continueOnFailure: false,
        metadata: toRecipeMetadata('wait-assert-evidence'),
        commands: [
            toConfigureCommand('wait-assert-evidence', options),
            toRtcConnectCommand({
                caseId: 'wait-assert-evidence',
                commandId: 'wait-assert-connect',
                connection: connection,
                roomId: roomId,
                transport: transport,
                options: options
            }),
            toConformanceMessageProbe({
                options,
                caseId: 'wait-assert-evidence',
                commandId: 'wait-assert-send',
                connection,
                roomId,
                transport,
                data: {
                    topic: 'rallar.conformance.wait-assert',
                    marker: 'wait-assert-evidence'
                }
            }),
            toConformanceMessageWait({
                commandId: 'wait-assert-wait-message',
                timeoutMs: options.timeoutMs,
                topic: 'rallar.conformance.wait-assert',
                caseId: 'wait-assert-evidence'
            }),
            ...toWaitEvidenceAssertions(),
            toStatsCommand('wait-assert-stats', 'wait-assert-evidence'),
            toCloseCommand('wait-assert-close', 'wait-assert-evidence')
        ]
    };
}

const WAIT_EVIDENCE_ASSERTIONS:
    readonly (Extract<RallarBlackBoxTestCommand, { kind: 'assert'; }> & { readonly commandId: string; })[] = [{
        kind: 'assert',
        commandId: 'wait-assert-check-message',
        source: 'messages.0.payload.data.marker',
        operator: 'equals',
        expected: 'wait-assert-evidence'
    }, {
        kind: 'assert',
        commandId: 'wait-assert-check-gt',
        source: 'state.messages.length',
        operator: 'gt',
        expected: 0
    }, {
        kind: 'assert',
        commandId: 'wait-assert-check-between',
        source: 'state.messages.length',
        operator: 'between',
        expected: [1, 50]
    }, {
        kind: 'assert',
        commandId: 'wait-assert-check-marker-length',
        source: 'messages.0.payload.data.marker',
        operator: 'length',
        expected: 'wait-assert-evidence'.length
    }, {
        kind: 'assert',
        commandId: 'wait-assert-check-topic-pattern',
        source: 'messages.0.payload.data.topic',
        operator: 'matches',
        expected: '^rallar\\.conformance\\.'
    }, {
        kind: 'assert',
        commandId: 'wait-assert-check-shape',
        source: 'messages.0.payload',
        operator: 'matchesShape',
        expected: {
            data: {
                marker: 'wait-assert-evidence'
            }
        }
    }];

function toWaitEvidenceAssertions(): readonly RallarBlackBoxTestCommand[] {
    return WAIT_EVIDENCE_ASSERTIONS.map((command) => ({
        ...command,
        metadata: toCommandMetadata('wait-assert-evidence', command.commandId)
    }));
}
