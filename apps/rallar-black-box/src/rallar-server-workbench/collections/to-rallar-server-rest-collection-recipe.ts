import type {
    RallarBlackBoxTestHttpRequestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { Either, EitherCollectors } from '@shared/resilience/Either.ts';
import type {
    RallarServerRestCollection,
    RallarServerRestCollectionStep,
    RallarServerRestCollectionVariables
} from '../rallar-server-workbench-contracts.ts';
import { toRallarServerBlackBoxCommand } from '../to-rallar-server-black-box-command.ts';
import {
    toRallarServerCollectionStepRequestInput,
    type RallarServerCollectionStepRequestSource
} from './to-rallar-server-collection-step-request-input.ts';

export interface RallarServerRestCollectionRecipeSource
    extends Omit<RallarServerCollectionStepRequestSource, 'step' | 'variables'> {
    readonly collection: RallarServerRestCollection;
    readonly variables: RallarServerRestCollectionVariables;
}

interface CollectionStepCommandSource {
    readonly source: RallarServerRestCollectionRecipeSource;
    readonly variables: RallarServerRestCollectionVariables;
    readonly step: RallarServerRestCollectionStep;
    readonly index: number;
}

/** A step whose request cannot be translated fails the whole recipe with the message of that step. */
export function toRallarServerRestCollectionRecipe(
    source: RallarServerRestCollectionRecipeSource
): Either<string, RallarBlackBoxTestRecipe> {
    const variables = { ...(source.collection.variables ?? {}), ...source.variables };
    const commands = source.collection.steps.map((step, index) =>
        toCollectionStepCommand({ source, variables, step, index })
    );
    const failure = EitherCollectors.toListFoldLefts(commands).at(0);
    if (failure !== undefined) {
        return Either.ofLeft(failure);
    }
    return Either.ofRight({
        schemaVersion: 1,
        recipeId: source.collection.collectionId,
        name: source.collection.name,
        continueOnFailure: false,
        commands: EitherCollectors.toListFoldRights(commands)
    });
}

function toCollectionStepCommand(
    { source, variables, step, index }: CollectionStepCommandSource
): Either<string, RallarBlackBoxTestHttpRequestCommand> {
    const request = toRallarServerCollectionStepRequestInput({ ...source, step, variables });
    const commandId = `${source.collection.collectionId}-${index + 1}-${step.stepId}`;
    return toRallarServerBlackBoxCommand({ request, commandId }).mapRight((command) => ({
        ...command,
        label: step.label,
        metadata: {
            restCollection: {
                collectionId: source.collection.collectionId,
                stepId: step.stepId,
                attachAuth: request.attachAuth,
                expect: step.expect,
                extract: step.extract
            }
        }
    }));
}
