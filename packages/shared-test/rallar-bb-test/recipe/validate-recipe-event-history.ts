import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestParallelGroup,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import {
    isSameEventHistoryPolicy,
    validateEventHistoryPolicy,
    type RallarBlackBoxEventHistoryPolicy
} from '../runtime/event-history.ts';
import { toInvalidRecipeOutcome } from '../runtime/runtime-command-outcomes.ts';
import { validateExecutableCommand } from './validate-executable-recipe.ts';

export interface RecipeEventHistorySelection {
    readonly policy: RallarBlackBoxEventHistoryPolicy;
    readonly runOverride: boolean;
}

interface RecipeHistoryValidation {
    loadedRecipes: readonly RallarBlackBoxTestRecipe[];
    readonly activeRecipes: ReadonlySet<RallarBlackBoxTestRecipe>;
    readonly observedLoads: Set<RallarBlackBoxTestRecipe>;
}

/** Resolve bodyless references against accepted bodies, following owned load transitions before effects. */
export function validateRecipeEventHistory(
    recipe: RallarBlackBoxTestRecipe,
    selection: RecipeEventHistorySelection,
    loadedRecipe: RallarBlackBoxTestRecipe | undefined
): readonly string[] {
    return validateAcceptedRecipe(recipe, selection, {
        loadedRecipes: loadedRecipe === undefined ? [] : [loadedRecipe],
        activeRecipes: new Set(),
        observedLoads: new Set()
    });
}

function validateAcceptedRecipe(
    recipe: RallarBlackBoxTestRecipe,
    selection: RecipeEventHistorySelection,
    state: RecipeHistoryValidation
): readonly string[] {
    if (state.activeRecipes.has(recipe)) {
        return ['A loaded recipe cannot recursively invoke its own accepted body.'];
    }
    const children = { ...state, activeRecipes: new Set([...state.activeRecipes, recipe]) };
    const issues = [
        ...(selection.runOverride ? [] : validateLockedPolicy(recipe.eventHistory, selection.policy)),
        ...validateChildCommands(recipe.commands, selection, children)
    ];
    state.loadedRecipes = children.loadedRecipes;
    return issues;
}

function validateChildCommands(
    commands: readonly RallarBlackBoxTestCommand[],
    selection: RecipeEventHistorySelection,
    state: RecipeHistoryValidation
): readonly string[] {
    return commands.flatMap((command) => validateChildEventHistory(command, selection, state));
}

function validateChildEventHistory(
    command: RallarBlackBoxTestCommand,
    selection: RecipeEventHistorySelection,
    state: RecipeHistoryValidation
): readonly string[] {
    switch (command.kind) {
        case 'recipe.run': {
            const recipes = command.recipe === undefined ? state.loadedRecipes : [command.recipe];
            return [
                ...validateLockedPolicy(command.eventHistory, selection.policy),
                ...(recipes.length === 0 ? ['No recipe is loaded for this child execution.'] : []),
                ...recipes.flatMap((recipe) => validateAcceptedRecipe(recipe, selection, state))
            ];
        }
        case 'recipe.load':
            state.loadedRecipes = [command.recipe];
            state.observedLoads.add(command.recipe);
            return selection.runOverride ? [] : validateLockedPolicy(command.recipe.eventHistory, selection.policy);
        case 'configure':
            return validateLockedPolicy(command.config.eventHistory, selection.policy);
        case 'reset':
            state.loadedRecipes = [];
            return [];
        case 'loop': {
            const initial = state.loadedRecipes;
            const issues = validateChildCommands(command.commands, selection, state);
            // Later iterations may enter with a body loaded by the previous iteration.
            state.loadedRecipes = [...new Set([...initial, ...state.loadedRecipes])];
            return [...issues, ...validateChildCommands(command.commands, selection, state)];
        }
        case 'parallel':
            return validateParallelEventHistory(command.groups, selection, state);
        default:
            return [];
    }
}

function validateParallelEventHistory(
    groups: readonly RallarBlackBoxTestParallelGroup[],
    selection: RecipeEventHistorySelection,
    state: RecipeHistoryValidation
): readonly string[] {
    const initial = state.loadedRecipes;
    const possible = new Set(initial);
    const issues = groups.flatMap((group) => {
        const branch = { ...state, loadedRecipes: initial, observedLoads: new Set<RallarBlackBoxTestRecipe>() };
        const issues = validateChildCommands(group.commands, selection, branch);
        for (const recipe of [...branch.loadedRecipes, ...branch.observedLoads]) {
            possible.add(recipe);
            state.observedLoads.add(recipe);
        }
        return issues;
    });
    // A concurrent bodyless invocation can see intermediate accepted loads, not only a group's final body.
    state.loadedRecipes = [...possible];
    return [
        ...issues,
        ...groups.flatMap((group) => {
            const branch = { ...state, loadedRecipes: [...possible] };
            return validateChildCommands(group.commands, selection, branch);
        })
    ];
}

/** A successful cached invocation is historical evidence; a fresh reference must match the current acknowledged load. */
export function resolveRecipeBodyBindingFailure(
    command: RallarBlackBoxTestCommand,
    loadedRecipeBodyId: string | undefined,
    cached: RallarBlackBoxTestResult | undefined
): RallarBlackBoxTestCommandOutcome | undefined {
    if (command.kind !== 'recipe.run' || command.expectedRecipeBodyId === undefined) {
        return undefined;
    }
    const issues = validateExecutableCommand(command);
    if (issues.length > 0) {
        return toInvalidRecipeOutcome(issues);
    }
    if (cached?.ok === false) {
        return undefined;
    }
    const actual = cached ? decodeRecord(decodeRecord(cached.value).invocation).recipeBodyId : loadedRecipeBodyId;
    return actual === command.expectedRecipeBodyId
        ? undefined
        : toInvalidRecipeOutcome(['The acknowledged recipe body is no longer available for this execution.']);
}

function validateLockedPolicy(
    requested: RallarBlackBoxEventHistoryPolicy | undefined,
    admitted: RallarBlackBoxEventHistoryPolicy
): readonly string[] {
    if (requested === undefined) {
        return [];
    }
    const issues = validateEventHistoryPolicy(requested);
    if (issues.length > 0) {
        return issues;
    }
    return isSameEventHistoryPolicy(requested, admitted)
        ? []
        : ['Nested event history selection conflicts with the admitted execution policy.'];
}
