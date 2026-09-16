import { useMemo } from 'react';
import {
    decodeManualPayloadText,
    toManualRecipeText,
    type ManualActionHistoryEntry,
    type ManualWorkbenchValues
} from '../../../manual-workbench.ts';
import { toManualRtcNegativeRecipeText } from '../../../manual-workbench/manual-rtc-probe-commands.ts';
import { toManualSendCommand } from '../../../manual-workbench/manual-workbench-commands.ts';
import { validateSchemaAuthoringText, validateSchemaAuthoringValue } from '../../../schema-authoring.ts';

interface ManualWorkbenchRecipeInput {
    readonly values: ManualWorkbenchValues;
    readonly payloadText: string;
    readonly sequence: number;
    readonly history: readonly ManualActionHistoryEntry[];
}
export function useManualWorkbenchRecipes({ values, payloadText, sequence, history }: ManualWorkbenchRecipeInput) {
    return useMemo(() => {
        const payloadResult = decodeManualPayloadText(payloadText);
        const previewCommands = payloadResult.fold(
            () => [],
            (payload) => [toManualSendCommand(values, payload, sequence)]
        );
        const recipeText = toManualRecipeText(history);
        const negativeRecipeText = payloadResult.fold(
            (error) => error,
            (payload) => toManualRtcNegativeRecipeText(values, payload)
        );
        return {
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
    }, [values, payloadText, sequence, history]);
}
