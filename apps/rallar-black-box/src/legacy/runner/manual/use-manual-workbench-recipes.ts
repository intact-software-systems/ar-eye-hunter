import { useMemo } from 'react';
import {
    parseManualPayload,
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
        const payloadResult = parseManualPayload(payloadText);
        const previewCommands = payloadResult.ok
            ? [toManualSendCommand(values, payloadResult.value, sequence)]
            : [];
        const recipeText = toManualRecipeText(history);
        const negativeRecipeText = payloadResult.ok
            ? toManualRtcNegativeRecipeText(values, payloadResult.value)
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
