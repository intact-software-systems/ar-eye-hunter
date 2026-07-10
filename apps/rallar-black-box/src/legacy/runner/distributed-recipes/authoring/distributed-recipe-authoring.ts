import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    distributedRecipePreflight,
    type DistributedRecipePreflightSummary,
} from '../../../../distributed-recipes.ts';
import type { DistributedRecipePromptValidationFeedback } from '../../../../distributed-recipe-authoring-prompts.ts';
import type {
    SchemaAuthoringTarget,
    SchemaAuthoringValidation,
} from '../../../../schema-authoring.ts';
import { recordValue } from '../../../shared/record-value.ts';

export type DistributedAuthoringDraftTarget = Extract<
    SchemaAuthoringTarget,
    'recipe' | 'distributed-run-manifest'
>;

export type DistributedAuthoringDraftPreflightEntry = Readonly<{
    id: string;
    title: string;
    preflight: DistributedRecipePreflightSummary;
}>;

export function distributedAuthoringDraftPreflights(
    validation: SchemaAuthoringValidation | undefined,
): readonly DistributedAuthoringDraftPreflightEntry[] {
    if (!validation?.ok) {
        return [];
    }

    if (
        validation.target === 'recipe' &&
        isRallarBlackBoxRecipeValue(validation.parsed)
    ) {
        return [
            {
                id: validation.parsed.recipeId,
                title: validation.parsed.name ?? validation.parsed.recipeId,
                preflight: distributedRecipePreflight(validation.parsed),
            },
        ];
    }

    if (
        validation.target !== 'distributed-run-manifest' ||
        !isDistributedManifestValue(validation.parsed)
    ) {
        return [];
    }

    return validation.parsed.recipes.flatMap((selection, index) => {
        const recipe = selection.recipe;
        if (!isRallarBlackBoxRecipeValue(recipe)) {
            return [];
        }
        const recipeId =
            selection.recipeId ?? recipe.recipeId ?? `recipe-${index + 1}`;
        return [
            {
                id: `${recipeId}-${index}`,
                title: recipe.name ?? recipeId,
                preflight: distributedRecipePreflight(recipe),
            },
        ];
    });
}

export function distributedPromptFeedbackFromValidation(
    validation: SchemaAuthoringValidation,
    preflights: readonly DistributedAuthoringDraftPreflightEntry[],
): DistributedRecipePromptValidationFeedback {
    const preflightErrors = preflights.flatMap((entry) =>
        entry.preflight.errors.map((issue) => `${entry.title}: ${issue}`),
    );
    const preflightWarnings = preflights.flatMap((entry) =>
        entry.preflight.warnings.map((issue) => `${entry.title}: ${issue}`),
    );

    return {
        target: validation.target,
        title: validation.title,
        ok: validation.ok && preflightErrors.length === 0,
        parseOk: validation.parseOk,
        schemaErrorText: validation.errorText,
        issues: validation.errorText
            ? []
            : validation.errors.map(
                  (issue) => `${issue.path}: ${issue.message}`,
              ),
        preflightErrors,
        preflightWarnings,
    };
}

function isRallarBlackBoxRecipeValue(
    value: unknown,
): value is RallarBlackBoxTestRecipe {
    const record = recordValue(value);
    return (
        typeof record.recipeId === 'string' && Array.isArray(record.commands)
    );
}

function isDistributedManifestValue(
    value: unknown,
): value is RallarBlackBoxDistributedRunManifest {
    const record = recordValue(value);
    return (
        typeof record.distributedRunId === 'string' &&
        Array.isArray(record.recipes)
    );
}
