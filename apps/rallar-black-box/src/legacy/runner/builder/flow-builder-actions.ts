import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { Either } from '@shared/resilience/Either.ts';
import type * as React from 'react';
import type { FlowBuilderDefinition, FlowBuilderStepKind } from '../../../flow-builder/flow-builder-contracts.ts';
import { appendFlowBuilderStep } from '../../../flow-builder/flow-builder-steps.ts';
import { resolveFlowBuilderTemplate } from '../../../flow-builder/flow-builder-templates.ts';
import { toFlowBuilderText } from '../../../flow-builder/to-flow-builder-text.ts';
import type { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import { writeTextToClipboard } from '../../shared/write-text-to-clipboard.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { toFlowBuilderVariablesText } from './to-flow-builder-variables-text.ts';

export namespace FlowBuilderActions {
    export interface Input {
        readonly globalValues: CommandCenterGlobalValues;
        readonly flowResult: Either<string, FlowBuilderDefinition>;
        /** Absent while the flow or variables text does not translate into a recipe; `parseError` then says why. */
        readonly recipe: RallarBlackBoxTestRecipe | undefined;
        /** Absent while the flow and variables text translate into `recipe`. */
        readonly parseError: string | undefined;
        readonly sequence: number;
        readonly setTemplateId: React.Dispatch<React.SetStateAction<string>>;
        readonly setFlowText: React.Dispatch<React.SetStateAction<string>>;
        readonly setVariablesText: React.Dispatch<React.SetStateAction<string>>;
        readonly setVariablesEdited: React.Dispatch<React.SetStateAction<boolean>>;
        readonly setSequence: React.Dispatch<React.SetStateAction<number>>;
        readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly runManualCommands: typeof rallarBlackBoxRuntimeStore.runManualCommands;
        onSelectCommand(commandId: string): void;
    }
}

export class FlowBuilderActions {
    private readonly input: FlowBuilderActions.Input;

    constructor(input: FlowBuilderActions.Input) {
        this.input = input;
    }

    readonly selectTemplate = (templateId: string): void => {
        const template = resolveFlowBuilderTemplate(templateId);
        this.input.setTemplateId(template.templateId);
        this.input.setFlowText(toFlowBuilderText(template.flow));
        this.input.setVariablesText(toFlowBuilderVariablesText(template.flow.variables, this.input.globalValues));
        this.input.setVariablesEdited(false);
        this.input.setLocalError(undefined);
    };

    readonly addStep = (kind: FlowBuilderStepKind): void => {
        this.input.flowResult.fold(
            (error) => this.input.setLocalError(error),
            (flow) => this.input.setFlowText(toFlowBuilderText(appendFlowBuilderStep(flow, kind)))
        );
    };

    readonly normalizeFlowJson = (): void => {
        this.input.flowResult.fold(
            (error) => this.input.setLocalError(error),
            (flow) => {
                this.input.setFlowText(toFlowBuilderText(flow));
                this.input.setLocalError(undefined);
            }
        );
    };

    readonly runFlow = async (): Promise<void> => {
        const { recipe, sequence } = this.input;
        this.input.setLocalError(undefined);
        if (!recipe) {
            this.input.setLocalError(this.input.parseError);
            return;
        }
        const commandId = `flow-builder-run-${sequence}`;
        this.input.setSequence((current) => current + 1);
        this.input.onSelectCommand(commandId);
        try {
            await this.input.runManualCommands(
                [{ kind: 'recipe.run', commandId, label: `Run ${recipe.name ?? recipe.recipeId}`, recipe }],
                'Run Flow Builder'
            );
        }
        catch (error) {
            this.input.setLocalError(error instanceof Error ? error.message : String(error));
        }
    };

    readonly copyText = async (text: string): Promise<void> => {
        this.input.setLocalError(undefined);
        const written = await writeTextToClipboard(text);
        written.foldLeft(this.input.setLocalError);
    };
}
