import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { FlowBuilderStep } from '../../../flow-builder/flow-builder-contracts.ts';
import type { SchemaAuthoringValidation } from '../../../schema-authoring.ts';
import { statusTone } from '../../shared/command-presentation.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { SchemaAuthoringPanel } from '../../shared/schema/SchemaAuthoringPanel.tsx';
import type { FlowBuilderControllerModel } from './use-flow-builder-controller.ts';

interface FlowBuilderPreviewsProps {
    readonly model: FlowBuilderControllerModel;
    readonly state: RallarBlackBoxTestState;
    /** Absent while the browser is signed out; the step expect and extract previews then redact no session token. */
    readonly authSession: AuthSession | undefined;
    onSelectCommand(commandId: string): void;
}

interface FlowBuilderStepRowProps extends Omit<FlowBuilderPreviewsProps, 'model'> {
    readonly step: FlowBuilderStep;
    /** Absent while the flow does not translate into a recipe, so the step has no commands yet. */
    readonly recipe: RallarBlackBoxTestRecipe | undefined;
}

interface FlowBuilderTextPreviewProps {
    readonly title: string;
    readonly meta: string;
    readonly text: string;
    /** Absent while there is no translated document to validate. */
    readonly validation: SchemaAuthoringValidation | undefined;
}

interface FlowBuilderStepProgress {
    readonly commandIds: readonly string[];
    readonly status: 'failed' | 'completed' | 'skipped' | 'pending';
}

export function FlowBuilderPreviews(props: FlowBuilderPreviewsProps) {
    const { model } = props;
    return (
        <div className="flow-builder-layout">
            <FlowBuilderStepList {...props} />
            <FlowBuilderTextPreview
                title="SPA Recipe Preview"
                meta={model.recipe?.recipeId ?? '-'}
                text={model.recipeText}
                validation={model.recipeValidation}
            />
            <FlowBuilderTextPreview
                title="Runner Scenario Preview"
                meta="black-box-runner"
                text={model.runnerText}
                validation={model.runnerValidation}
            />
        </div>
    );
}

function FlowBuilderStepList({ model, ...row }: FlowBuilderPreviewsProps) {
    const { flow, recipe } = model;
    return (
        <section className="flow-builder-steps">
            <div className="section-heading">
                <h3>Steps</h3>
                <span>{flow?.steps.length ?? 0} steps</span>
            </div>
            <div className="flow-step-list">
                {!flow && <div className="empty-state">No valid flow loaded</div>}
                {flow?.steps.map((step) => (
                    <FlowBuilderStepRow
                        key={step.stepId}
                        {...row}
                        step={step}
                        recipe={recipe}
                    />
                ))}
            </div>
        </section>
    );
}

function FlowBuilderStepRow({ step, recipe, state, authSession, onSelectCommand }: FlowBuilderStepRowProps) {
    const { commandIds, status } = toFlowBuilderStepProgress(step, recipe, state.resultCache);
    return (
        <article className="flow-step-row">
            <div>
                <strong>{step.label}</strong>
                <small>
                    {step.stepId} - {step.kind}
                </small>
            </div>
            <span className={`pill ${status === 'completed' ? 'good' : statusTone(status)}`}>{status}</span>
            <div className="manual-command-links">
                {commandIds.map((commandId) => (
                    <button
                        type="button"
                        key={commandId}
                        onClick={() => onSelectCommand(commandId)}
                    >
                        {commandId}
                    </button>
                ))}
            </div>
            {(step.expect !== undefined || step.extract !== undefined) && (
                <pre className="mini-json">
                    {redactedJson({ expect: step.expect, extract: step.extract }, state, authSession)}
                </pre>
            )}
        </article>
    );
}

function FlowBuilderTextPreview({ title, meta, text, validation }: FlowBuilderTextPreviewProps) {
    return (
        <section className="flow-builder-preview">
            <div className="section-heading">
                <h3>{title}</h3>
                <span>{meta}</span>
            </div>
            <pre className="json-block">{text}</pre>
            {validation && <SchemaAuthoringPanel validation={validation} />}
        </section>
    );
}

/** A step completes only once every one of its commands has a result; any failed result fails it. */
function toFlowBuilderStepProgress(
    step: FlowBuilderStep,
    recipe: RallarBlackBoxTestRecipe | undefined,
    resultCache: RallarBlackBoxTestState['resultCache']
): FlowBuilderStepProgress {
    const commandIds = recipe ? toFlowStepCommandIds(recipe.commands, step.stepId) : [];
    const results = commandIds
        .map((commandId) => resultCache[commandId])
        .filter((result): result is RallarBlackBoxTestResult => Boolean(result));
    const failed = results.some((result) => !result.ok);
    const completed = commandIds.length > 0 && results.length === commandIds.length;
    const status = failed ? 'failed' : completed ? 'completed' : step.enabled === false ? 'skipped' : 'pending';
    return { commandIds, status };
}

function toFlowStepCommandIds(recipeCommands: readonly RallarBlackBoxTestCommand[], stepId: string): readonly string[] {
    return recipeCommands
        .filter((command) => decodeRecord(command.metadata?.flow).stepId === stepId)
        .map((command, index) => command.commandId ?? `${command.kind}-${index + 1}`);
}
