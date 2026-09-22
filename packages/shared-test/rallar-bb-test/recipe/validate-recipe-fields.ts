import { toControlCommandIssue, type ControlCommandIssue } from '../control/control-command-issue.ts';
import {
    validateAllowedFields,
    validateBooleanField,
    validateObjectField,
    validateRequiredFields,
    validateStringField
} from '../control/validate-control-command-fields.ts';
import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS } from '../schema/rallar-black-box-command-fields.ts';

const RECIPE_FIELDS_WITH_OWN_MESSAGE:
    readonly (typeof RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS)['recipe']['required'][number][] = [
        'schemaVersion',
        'commands'
    ];

export function validateRecipeFields(recipe: RallarBlackBoxTestRecord, path: string): readonly ControlCommandIssue[] {
    const fields = RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.recipe;
    return [
        ...validateAllowedFields(recipe, fields, path),
        ...(recipe.schemaVersion === 1 ? [] : [toControlCommandIssue(`${path}.schemaVersion must be 1.`)]),
        ...validateRequiredFields({ record: recipe, fields, path, ownMessageFields: RECIPE_FIELDS_WITH_OWN_MESSAGE }),
        ...validateStringField(recipe, 'recipeId', path),
        ...validateStringField(recipe, 'name', path),
        ...validateStringField(recipe, 'description', path),
        ...validateBooleanField(recipe, 'continueOnFailure', path),
        ...validateObjectField(recipe, 'metadata', path)
    ];
}
