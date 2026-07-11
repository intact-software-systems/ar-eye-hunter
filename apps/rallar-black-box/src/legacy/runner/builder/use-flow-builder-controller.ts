import { useEffect, useMemo, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import {
    FLOW_BUILDER_TEMPLATES,
    addFlowBuilderStep,
    buildFlowBuilderRecipe,
    buildFlowBuilderRunnerScenario,
    flowBuilderText,
    parseFlowBuilderDefinition,
    templateFlowBuilderText,
    type FlowBuilderStepKind,
} from '../../../flow-builder.ts';
import { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import { validateSchemaAuthoringValue } from '../../../schema-authoring.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import {
    flowBuilderVariablesFromGlobalValues,
    parseVariablesText,
} from './flow-builder-support.ts';

export type UseFlowBuilderControllerInput = Readonly<{
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    onSelectCommand(commandId: string): void;
}>;

export function useFlowBuilderController({
    state,
    authSession,
    globalValues,
    onSelectCommand,
}: UseFlowBuilderControllerInput) {
    const [templateId, setTemplateId] = useState(
        FLOW_BUILDER_TEMPLATES[0].templateId,
    );
    const [flowText, setFlowText] = useState(() =>
        templateFlowBuilderText(templateId),
    );
    const [variablesText, setVariablesText] = useState(() =>
        JSON.stringify(
            flowBuilderVariablesFromGlobalValues(
                FLOW_BUILDER_TEMPLATES[0].flow.variables,
                globalValues,
            ),
            null,
            2,
        ),
    );
    const [variablesEdited, setVariablesEdited] = useState(false);
    const [sequence, setSequence] = useState(1);
    const [localError, setLocalError] = useState<string | undefined>();
    const flowResult = useMemo(
        () => parseFlowBuilderDefinition(flowText),
        [flowText],
    );
    const variablesResult = useMemo(
        () => parseVariablesText(variablesText),
        [variablesText],
    );
    const recipe = useMemo(() => {
        if (!flowResult.ok || !variablesResult.ok) {
            return undefined;
        }

        return buildFlowBuilderRecipe(
            flowResult.flow,
            variablesResult.variables,
        );
    }, [flowResult, variablesResult]);
    const runnerScenario = useMemo(() => {
        if (!flowResult.ok || !variablesResult.ok) {
            return undefined;
        }

        return buildFlowBuilderRunnerScenario(
            flowResult.flow,
            variablesResult.variables,
        );
    }, [flowResult, variablesResult]);
    const parseError = !flowResult.ok
        ? flowResult.error
        : !variablesResult.ok
          ? variablesResult.error
          : undefined;
    const recipeText = recipe
        ? redactedJson(recipe, state, authSession)
        : (parseError ?? 'No recipe preview available.');
    const runnerText = runnerScenario
        ? redactedJson(runnerScenario, state, authSession)
        : recipeText;
    const recipeValidation = useMemo(
        () =>
            recipe ? validateSchemaAuthoringValue('recipe', recipe) : undefined,
        [recipe],
    );
    const runnerValidation = useMemo(
        () =>
            runnerScenario
                ? validateSchemaAuthoringValue(
                      'runner-scenario',
                      runnerScenario,
                  )
                : undefined,
        [runnerScenario],
    );

    const selectTemplate = (nextTemplateId: string): void => {
        const template =
            FLOW_BUILDER_TEMPLATES.find(
                (entry) => entry.templateId === nextTemplateId,
            ) ?? FLOW_BUILDER_TEMPLATES[0];
        setTemplateId(template.templateId);
        setFlowText(flowBuilderText(template.flow));
        setVariablesText(
            JSON.stringify(
                flowBuilderVariablesFromGlobalValues(
                    template.flow.variables,
                    globalValues,
                ),
                null,
                2,
            ),
        );
        setVariablesEdited(false);
        setLocalError(undefined);
    };

    useEffect(() => {
        if (variablesEdited) {
            return;
        }

        const template =
            FLOW_BUILDER_TEMPLATES.find(
                (entry) => entry.templateId === templateId,
            ) ?? FLOW_BUILDER_TEMPLATES[0];
        setVariablesText(
            JSON.stringify(
                flowBuilderVariablesFromGlobalValues(
                    template.flow.variables,
                    globalValues,
                ),
                null,
                2,
            ),
        );
    }, [
        globalValues?.apiBaseUrl,
        globalValues?.applicationId,
        globalValues?.clientId,
        globalValues?.roomId,
        globalValues?.sessionId,
        globalValues?.workspaceId,
        templateId,
        variablesEdited,
    ]);

    const addStep = (kind: FlowBuilderStepKind): void => {
        if (!flowResult.ok) {
            setLocalError(flowResult.error);
            return;
        }

        setFlowText(flowBuilderText(addFlowBuilderStep(flowResult.flow, kind)));
    };

    const normalizeFlowJson = (): void => {
        if (!flowResult.ok) {
            setLocalError(flowResult.error);
            return;
        }

        setFlowText(flowBuilderText(flowResult.flow));
        setLocalError(undefined);
    };

    const runFlow = async (): Promise<void> => {
        setLocalError(undefined);
        if (!recipe) {
            setLocalError(parseError ?? 'No flow recipe is available.');
            return;
        }

        const commandId = `flow-builder-run-${sequence}`;
        setSequence((current) => current + 1);
        onSelectCommand(commandId);
        try {
            await rallarBlackBoxRuntimeStore.executeManualCommands(
                [
                    {
                        kind: 'recipe.run',
                        commandId,
                        label: `Run ${recipe.name ?? recipe.recipeId}`,
                        recipe,
                    },
                ],
                'Run Flow Builder',
            );
        } catch (error) {
            setLocalError(
                error instanceof Error ? error.message : String(error),
            );
        }
    };

    const copyText = (text: string): void => {
        void navigator.clipboard?.writeText(text);
    };

    const flow = flowResult.ok ? flowResult.flow : undefined;

    return {
        templateId,
        flowText,
        setFlowText,
        variablesText,
        setVariablesText,
        setVariablesEdited,
        flow,
        recipe,
        runnerScenario,
        parseError,
        recipeText,
        runnerText,
        recipeValidation,
        runnerValidation,
        localError,
        selectTemplate,
        addStep,
        normalizeFlowJson,
        runFlow,
        copyText,
    };
}

export type FlowBuilderControllerModel = ReturnType<
    typeof useFlowBuilderController
>;
