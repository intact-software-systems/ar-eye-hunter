import { useMemo } from 'react';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRtcConnectCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { Either } from '@shared/resilience/Either.ts';

import {
    decodeManualPayloadText,
    toManualRecipeText,
    type ManualActionHistoryEntry,
    type ManualWorkbenchValues
} from '../../../manual-workbench.ts';
import { decodeManualRtcReadinessText } from '../../../manual-workbench/manual-command-fields.ts';
import { toManualRtcNegativeRecipeText } from '../../../manual-workbench/manual-rtc-probe-commands.ts';
import { toManualSendCommand } from '../../../manual-workbench/manual-workbench-commands.ts';
import {
    validateSchemaAuthoringText,
    validateSchemaAuthoringValue,
    type SchemaAuthoringValidation
} from '../../../schema-authoring.ts';

interface ManualWorkbenchRecipeInput {
    readonly values: ManualWorkbenchValues;
    readonly payloadText: string;
    readonly sequence: number;
    readonly history: readonly ManualActionHistoryEntry[];
}
interface ManualWorkbenchRecipes {
    readonly rtcReadinessResult: Either<string, RallarBlackBoxTestRtcConnectCommand>;
    readonly payloadResult: Either<string, RallarMessagePayload>;
    readonly previewCommands: readonly RallarBlackBoxTestCommand[];
    readonly recipeText: string;
    readonly negativeRecipeText: string;
    /** Absent while the payload is invalid. */
    readonly previewRecipeValidation: SchemaAuthoringValidation | undefined;
    readonly manualRecipeValidation: SchemaAuthoringValidation;
    /** Absent while the payload is invalid. */
    readonly negativeRecipeValidation: SchemaAuthoringValidation | undefined;
}

export function useManualWorkbenchRecipes(input: ManualWorkbenchRecipeInput): ManualWorkbenchRecipes {
    return useMemo(
        () => computeManualWorkbenchRecipes(input),
        [input.values, input.payloadText, input.sequence, input.history]
    );
}

function computeManualWorkbenchRecipes(
    { values, payloadText, sequence, history }: ManualWorkbenchRecipeInput
): ManualWorkbenchRecipes {
    const rtcReadinessResult = decodeManualRtcReadinessText(values.rtcReadinessText);
    const payloadResult = decodeManualPayloadText(payloadText);
    const previewCommands = payloadResult.fold(
        () => [],
        (payload) => [toManualSendCommand(values, payload, sequence)]
    );
    const recipeText = toManualRecipeText(history);
    const negativeRecipeText = payloadResult.fold(
        (error) => error,
        (payload) =>
            rtcReadinessResult.fold(
                (error) => error,
                (rtcConnect) => toManualRtcNegativeRecipeText(values, payload, rtcConnect)
            )
    );
    return {
        rtcReadinessResult,
        payloadResult,
        previewCommands,
        recipeText,
        negativeRecipeText,
        previewRecipeValidation: payloadResult.foldRight(() =>
            validateSchemaAuthoringValue('recipe', {
                schemaVersion: 1,
                recipeId: 'manual-rallar-command-preview',
                commands: previewCommands
            })
        ),
        manualRecipeValidation: validateSchemaAuthoringText('recipe', recipeText),
        negativeRecipeValidation: payloadResult.foldRight(() =>
            validateSchemaAuthoringText('recipe', negativeRecipeText)
        )
    };
}
