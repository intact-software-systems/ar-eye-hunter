import type { ControlCommandEnvelope } from '../control-protocol.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestExecutionInput,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecipeRunCommand
} from '../rallar-black-box-test-contracts.ts';
import {
    isSameEventHistoryPolicy,
    resolveEventHistoryPolicyFailure,
    type RallarBlackBoxEventHistory,
    type RallarBlackBoxEventHistoryPolicy
} from '../runtime/event-history.ts';
import { toInvalidRecipeOutcome } from '../runtime/runtime-command-outcomes.ts';
import { decodeRecipeExecutionSegment } from './run-recipe-commands.ts';
import { snapshotExecutableCommand } from './snapshot-executable-recipe.ts';
import { validateExecutableCommand, validateExecutableRecipe } from './validate-executable-recipe.ts';
import { validateRecipeEventHistory, type RecipeEventHistorySelection } from './validate-recipe-event-history.ts';

export interface RecipeEventHistoryAdmissionFacts {
    readonly command: RallarBlackBoxTestCommand;
    readonly loadedRecipe: RallarBlackBoxTestRecipe | undefined;
    readonly executionLoadedRecipe: RallarBlackBoxTestRecipe | undefined;
    readonly configuredPolicy: RallarBlackBoxEventHistoryPolicy;
    readonly currentHistory: RallarBlackBoxEventHistory;
    readonly activeExecutions: number;
    readonly admittedPolicy: RallarBlackBoxEventHistoryPolicy | undefined;
    readonly admittedRunOverride: boolean;
    readonly execution: ControlCommandEnvelope['recipeExecution'];
}

export interface RecipeEventHistoryAdmission {
    readonly selection: RecipeEventHistorySelection | undefined;
    readonly failure: RallarBlackBoxTestCommandOutcome | undefined;
}

/** Resolve selection and validate accepted intent from immutable facts; registration and effects belong to the runtime. */
export function resolveRecipeEventHistoryAdmission(
    input: RecipeEventHistoryAdmissionFacts
): RecipeEventHistoryAdmission {
    const { command } = input;
    const recipe = command.kind === 'recipe.run' ? command.recipe ?? input.loadedRecipe : undefined;
    const policy = command.kind === 'recipe.run'
        ? input.admittedPolicy ?? command.eventHistory ?? recipe?.eventHistory ?? input.configuredPolicy
        : command.kind === 'configure'
        ? command.config.eventHistory
        : undefined;
    const failure = resolveEventHistoryPolicyFailure(policy, input.currentHistory, input.activeExecutions);
    if (failure || command.kind !== 'recipe.run') {
        return { selection: undefined, failure };
    }
    if (recipe === undefined) {
        return { selection: undefined, failure: toInvalidRecipeOutcome(['No recipe is loaded.']) };
    }
    if (
        input.execution?.first === false && (input.admittedPolicy === undefined ||
            input.admittedRunOverride !== (command.eventHistory !== undefined))
    ) {
        return {
            selection: undefined,
            failure: toInvalidRecipeOutcome([
                'Owned continuation requires its admitted selection and original run provenance.'
            ])
        };
    }
    const selection = {
        policy: policy ?? input.configuredPolicy,
        runOverride: input.admittedPolicy === undefined ? command.eventHistory !== undefined : input.admittedRunOverride
    };
    const issues = validateRecipeHistoryAdmission({
        command,
        recipe,
        selection,
        loadedRecipe: input.executionLoadedRecipe,
        execution: input.execution
    });
    return { selection, failure: issues.length === 0 ? undefined : toInvalidRecipeOutcome(issues) };
}

export interface RecipeHistoryAdmissionInput {
    readonly command: RallarBlackBoxTestRecipeRunCommand;
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly selection: RecipeEventHistorySelection;
    readonly loadedRecipe: RallarBlackBoxTestRecipe | undefined;
    readonly execution: ControlCommandEnvelope['recipeExecution'];
}

/** Validate original intent once, then validate only the continuing range against its immutable selection. */
export function validateRecipeHistoryAdmission(input: RecipeHistoryAdmissionInput): readonly string[] {
    const { command, recipe, selection, execution } = input;
    const issues = [
        ...validateExecutableCommand(command),
        ...(command.recipe === undefined ? validateExecutableRecipe(recipe) : [])
    ];
    if (issues.length > 0) {
        return issues;
    }
    const segment = execution?.segment;
    if (
        execution !== undefined && (segment === undefined || execution.first !== segment.first ||
            decodeRecipeExecutionSegment(segment).left !== undefined || segment.end > recipe.commands.length)
    ) {
        return ['Recipe execution segment exceeds its accepted outer intent.'];
    }
    if (command.eventHistory !== undefined && !isSameEventHistoryPolicy(command.eventHistory, selection.policy)) {
        return ['Run event history conflicts with the admitted outer execution selection.'];
    }
    const admitted = segment === undefined || segment.first
        ? recipe
        : { ...recipe, commands: recipe.commands.slice(segment.start, segment.end) };
    return validateRecipeEventHistory(admitted, selection, input.loadedRecipe);
}

/** An owned continuation keeps its accepted outer intent while the current physical identity/deadline changes. */
export function snapshotAdmittedRecipeCommand(
    command: RallarBlackBoxTestCommand,
    admitted: RallarBlackBoxTestRecipeRunCommand | undefined
): RallarBlackBoxTestCommand {
    return snapshotExecutableCommand(
        admitted === undefined ? command : {
            ...admitted,
            commandId: command.commandId,
            deadlineEpochMs: command.deadlineEpochMs ?? admitted.deadlineEpochMs
        }
    );
}

/** Own finite admission facts before command-ID or executor callbacks can change caller data. */
export function snapshotExecutionInput(input: RallarBlackBoxTestExecutionInput): RallarBlackBoxTestExecutionInput {
    return Object.freeze({
        controlIdentity: input.controlIdentity && Object.freeze({ ...input.controlIdentity }),
        eventHistorySelection: input.eventHistorySelection && Object.freeze({
            ...input.eventHistorySelection,
            policy: Object.freeze({ ...input.eventHistorySelection.policy })
        }),
        recipeExecution: input.recipeExecution && Object.freeze({
            ...input.recipeExecution,
            segment: input.recipeExecution.segment && Object.freeze({ ...input.recipeExecution.segment })
        })
    });
}
