import type {
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import type * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { decodeFlowBuilderDefinitionText } from '../../../flow-builder/decode-flow-builder-definition-text.ts';
import type { FlowBuilderDefinition, FlowBuilderStepKind } from '../../../flow-builder/flow-builder-contracts.ts';
import { FLOW_BUILDER_TEMPLATES, resolveFlowBuilderTemplate } from '../../../flow-builder/flow-builder-templates.ts';
import { toFlowBuilderRecipe, type FlowBuilderRecipeInput } from '../../../flow-builder/to-flow-builder-recipe.ts';
import {
    toFlowBuilderRunnerScenario,
    type FlowBuilderRunnerScenario
} from '../../../flow-builder/to-flow-builder-runner-scenario.ts';
import { toFlowBuilderText } from '../../../flow-builder/to-flow-builder-text.ts';
import { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import { validateSchemaAuthoringValue, type SchemaAuthoringValidation } from '../../../schema-authoring.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { decodeFlowBuilderVariablesText } from './decode-flow-builder-variables-text.ts';
import { FlowBuilderActions } from './flow-builder-actions.ts';
import { toFlowBuilderVariablesText } from './to-flow-builder-variables-text.ts';

export interface UseFlowBuilderControllerInput {
    readonly state: RallarBlackBoxTestState;
    readonly authSession: AuthSession | undefined;
    readonly globalValues: CommandCenterGlobalValues | undefined;
    onSelectCommand(commandId: string): void;
}

export interface FlowBuilderControllerModel {
    readonly templateId: string;
    readonly flowText: string;
    setFlowText(value: string): void;
    readonly variablesText: string;
    setVariablesText(value: string): void;
    setVariablesEdited(value: boolean): void;
    readonly flow: FlowBuilderDefinition | undefined;
    readonly recipe: RallarBlackBoxTestRecipe | undefined;
    readonly runnerScenario: FlowBuilderRunnerScenario | undefined;
    readonly parseError: string | undefined;
    readonly recipeText: string;
    readonly runnerText: string;
    readonly recipeValidation: SchemaAuthoringValidation | undefined;
    readonly runnerValidation: SchemaAuthoringValidation | undefined;
    readonly localError: string | undefined;
    selectTemplate(templateId: string): void;
    addStep(kind: FlowBuilderStepKind): void;
    normalizeFlowJson(): void;
    runFlow(): Promise<void>;
    copyText(text: string): void;
}

interface FlowBuilderDrafts {
    readonly templateId: string;
    readonly setTemplateId: React.Dispatch<React.SetStateAction<string>>;
    readonly flowText: string;
    readonly setFlowText: React.Dispatch<React.SetStateAction<string>>;
    readonly variablesText: string;
    readonly setVariablesText: React.Dispatch<React.SetStateAction<string>>;
    readonly setVariablesEdited: React.Dispatch<React.SetStateAction<boolean>>;
    readonly sequence: number;
    readonly setSequence: React.Dispatch<React.SetStateAction<number>>;
    readonly localError: string | undefined;
    readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
}

interface FlowBuilderPreview {
    readonly flowResult: Either<string, FlowBuilderDefinition>;
    readonly recipe: RallarBlackBoxTestRecipe | undefined;
    readonly runnerScenario: FlowBuilderRunnerScenario | undefined;
    readonly parseError: string | undefined;
    readonly recipeText: string;
    readonly runnerText: string;
    readonly recipeValidation: SchemaAuthoringValidation | undefined;
    readonly runnerValidation: SchemaAuthoringValidation | undefined;
}

export function useFlowBuilderController(input: UseFlowBuilderControllerInput): FlowBuilderControllerModel {
    const drafts = useFlowBuilderDrafts(input.globalValues);
    const preview = useFlowBuilderPreview(input, drafts);
    const actions = new FlowBuilderActions({
        ...input,
        ...drafts,
        ...preview,
        runManualCommands: (commands, label) => rallarBlackBoxRuntimeStore.executeManualCommands(commands, label)
    });
    return {
        templateId: drafts.templateId,
        flowText: drafts.flowText,
        setFlowText: drafts.setFlowText,
        variablesText: drafts.variablesText,
        setVariablesText: drafts.setVariablesText,
        setVariablesEdited: drafts.setVariablesEdited,
        flow: preview.flowResult.foldRight((flow) => flow),
        recipe: preview.recipe,
        runnerScenario: preview.runnerScenario,
        parseError: preview.parseError,
        recipeText: preview.recipeText,
        runnerText: preview.runnerText,
        recipeValidation: preview.recipeValidation,
        runnerValidation: preview.runnerValidation,
        localError: drafts.localError,
        selectTemplate: actions.selectTemplate,
        addStep: actions.addStep,
        normalizeFlowJson: actions.normalizeFlowJson,
        runFlow: actions.runFlow,
        copyText: actions.copyText
    };
}

function useFlowBuilderDrafts(globalValues: CommandCenterGlobalValues | undefined): FlowBuilderDrafts {
    const firstTemplate = FLOW_BUILDER_TEMPLATES[0];
    const [templateId, setTemplateId] = useState(firstTemplate.templateId);
    const [flowText, setFlowText] = useState(() => toFlowBuilderText(firstTemplate.flow));
    const [variablesText, setVariablesText] = useState(() =>
        toFlowBuilderVariablesText(firstTemplate.flow.variables, globalValues)
    );
    const [variablesEdited, setVariablesEdited] = useState(false);
    const [sequence, setSequence] = useState(1);
    const [localError, setLocalError] = useState<string | undefined>();
    useEffect(() => {
        if (!variablesEdited) {
            setVariablesText(
                toFlowBuilderVariablesText(resolveFlowBuilderTemplate(templateId).flow.variables, globalValues)
            );
        }
    }, [
        globalValues?.apiBaseUrl,
        globalValues?.applicationId,
        globalValues?.clientId,
        globalValues?.roomId,
        globalValues?.sessionId,
        globalValues?.workspaceId,
        templateId,
        variablesEdited
    ]);
    return {
        templateId,
        setTemplateId,
        flowText,
        setFlowText,
        variablesText,
        setVariablesText,
        setVariablesEdited,
        sequence,
        setSequence,
        localError,
        setLocalError
    };
}

function useFlowBuilderPreview(
    { state, authSession }: UseFlowBuilderControllerInput,
    { flowText, variablesText }: FlowBuilderDrafts
): FlowBuilderPreview {
    const flowResult = useMemo(() => decodeFlowBuilderDefinitionText(flowText), [flowText]);
    const recipeInput = useFlowBuilderRecipeInput(flowResult, variablesText);
    const recipe = useMemo(() => recipeInput.foldRight(toFlowBuilderRecipe), [recipeInput]);
    const runnerScenario = useMemo(() => recipeInput.foldRight(toFlowBuilderRunnerScenario), [recipeInput]);
    const recipeValidation = useMemo(() => recipe && validateSchemaAuthoringValue('recipe', recipe), [recipe]);
    const runnerValidation = useMemo(
        () => runnerScenario && validateSchemaAuthoringValue('runner-scenario', runnerScenario),
        [runnerScenario]
    );
    const parseError = recipeInput.foldLeft((error) => error);
    const recipeText = recipe
        ? redactedJson(recipe, state, authSession)
        : (parseError ?? 'No recipe preview available.');
    const runnerText = runnerScenario ? redactedJson(runnerScenario, state, authSession) : recipeText;
    return {
        flowResult,
        recipe,
        runnerScenario,
        parseError,
        recipeText,
        runnerText,
        recipeValidation,
        runnerValidation
    };
}

/** A flow parse failure is reported before a variables parse failure. */
function useFlowBuilderRecipeInput(
    flowResult: Either<string, FlowBuilderDefinition>,
    variablesText: string
): Either<string, FlowBuilderRecipeInput> {
    const variablesResult = useMemo(() => decodeFlowBuilderVariablesText(variablesText), [variablesText]);
    return useMemo(
        () =>
            flowResult.flatMap(
                (error) => Either.ofLeft(error),
                (flow) =>
                    variablesResult.mapRight((overrides) => ({
                        flow,
                        overrides,
                        createRequestId: () => crypto.randomUUID()
                    }))
            ),
        [flowResult, variablesResult]
    );
}
