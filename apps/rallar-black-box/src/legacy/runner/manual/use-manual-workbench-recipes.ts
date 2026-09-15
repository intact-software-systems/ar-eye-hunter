import { useMemo } from 'react';
import { manualSendCommand } from '../../../manual-workbench.ts';
import {
    manualRecipeSnippet,
    manualRtcNegativeRecipeSnippet,
    parseManualPayload,
    type ManualActionHistoryEntry,
    type ManualWorkbenchValues
} from '../../../manual-workbench.ts';
import { validateSchemaAuthoringText, validateSchemaAuthoringValue } from '../../../schema-authoring.ts';

interface ManualWorkbenchRecipeInput {
    readonly values: ManualWorkbenchValues;
    readonly payloadText: string;
    readonly sequence: number;
    readonly history: readonly ManualActionHistoryEntry[];
}
export function useManualWorkbenchRecipes({ values, payloadText, sequence, history }: ManualWorkbenchRecipeInput) {
    return useMemo(() => {
        const payloadResult = parseManualPayload(payloadText);
        const previewCommands = payloadResult.ok
            ? [manualSendCommand(values, payloadResult.value, sequence)]
            : [];
        const recipeText = manualRecipeSnippet(history);
        const negativeRecipeText = payloadResult.ok
            ? manualRtcNegativeRecipeSnippet(values, payloadResult.value)
            : payloadResult.error;
        return {
            payloadResult,
            previewCommands,
            recipeText,
            negativeRecipeText,
            previewRecipeValidation: payloadResult.ok
                ? validateSchemaAuthoringValue('recipe', {
                    schemaVersion: 1,
                    recipeId: 'manual-rallar-command-preview',
                    commands: previewCommands
                })
                : undefined,
            manualRecipeValidation: recipeText.trim().length > 0
                ? validateSchemaAuthoringText('recipe', recipeText)
                : undefined,
            negativeRecipeValidation: payloadResult.ok
                ? validateSchemaAuthoringText('recipe', negativeRecipeText)
                : undefined
        };
    }, [values, payloadText, sequence, history]);
}
