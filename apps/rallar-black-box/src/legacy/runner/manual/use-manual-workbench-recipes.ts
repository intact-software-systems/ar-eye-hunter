import { useMemo } from 'react';

import {
    decodeManualPayloadText,
    toManualRecipeText,
    type ManualActionHistoryEntry,
    type ManualWorkbenchValues
} from '../../../manual-workbench.ts';
import { decodeManualRtcReadinessText } from '../../../manual-workbench/manual-command-fields.ts';
import { toManualRtcNegativeRecipeText } from '../../../manual-workbench/manual-rtc-probe-commands.ts';
import { toManualSendCommand } from '../../../manual-workbench/manual-workbench-commands.ts';
import { validateSchemaAuthoringText, validateSchemaAuthoringValue } from '../../../schema-authoring.ts';

interface ManualWorkbenchRecipeInput {
    readonly values: ManualWorkbenchValues;
    readonly payloadText: string;
    readonly sequence: number;
    readonly history: readonly ManualActionHistoryEntry[];
}
export function useManualWorkbenchRecipes(input: ManualWorkbenchRecipeInput) {
    return useMemo(
        () => computeManualWorkbenchRecipes(input),
        [input.values, input.payloadText, input.sequence, input.history]
    );
}

function computeManualWorkbenchRecipes({ values, payloadText, sequence, history }: ManualWorkbenchRecipeInput) {
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
        manualRecipeValidation: recipeText.trim().length > 0
            ? validateSchemaAuthoringText('recipe', recipeText)
            : undefined,
        negativeRecipeValidation: payloadResult.foldRight(() =>
            validateSchemaAuthoringText('recipe', negativeRecipeText)
        )
    };
}
