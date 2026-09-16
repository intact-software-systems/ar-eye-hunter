import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { FlowBuilderDefinition } from '../../../flow-builder/flow-builder-contracts.ts';
import type { SchemaAuthoringValidation } from '../../../schema-authoring.ts';
import { statusTone } from '../../shared/command-presentation.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { SchemaAuthoringPanel } from '../../shared/schema/SchemaAuthoringPanel.tsx';

interface FlowBuilderPreviewsProps {
    readonly flow: FlowBuilderDefinition | undefined;
    readonly recipe: RallarBlackBoxTestRecipe | undefined;
    readonly state: RallarBlackBoxTestState;
    readonly authSession: AuthSession | undefined;
    onSelectCommand(commandId: string): void;
    readonly recipeText: string;
    readonly recipeValidation: SchemaAuthoringValidation | undefined;
    readonly runnerText: string;
    readonly runnerValidation: SchemaAuthoringValidation | undefined;
}

export function FlowBuilderPreviews({
    flow,
    recipe,
    state,
    authSession,
    onSelectCommand,
    recipeText,
    recipeValidation,
    runnerText,
    runnerValidation
}: FlowBuilderPreviewsProps) {
    return (
        <div className="flow-builder-layout">
            <section className="flow-builder-steps">
                <div className="section-heading">
                    <h3>Steps</h3>
                    <span>{flow?.steps.length ?? 0} steps</span>
                </div>
                <div className="flow-step-list">
                    {!flow && (
                        <div className="empty-state">
                            No valid flow loaded
                        </div>
                    )}
                    {flow?.steps.map((step) => {
                        const commandIds = recipe
                            ? toFlowStepCommandIds(
                                recipe.commands,
                                step.stepId
                            )
                            : [];
                        const results = commandIds
                            .map(
                                (commandId) => state.resultCache[commandId]
                            )
                            .filter(
                                (
                                    result
                                ): result is RallarBlackBoxTestResult => Boolean(result)
                            );
                        const failed = results.find((result) => !result.ok);
                        const completed = commandIds.length > 0 &&
                            results.length === commandIds.length;
                        const status = failed
                            ? 'failed'
                            : completed
                            ? 'completed'
                            : step.enabled === false
                            ? 'skipped'
                            : 'pending';
                        return (
                            <article
                                className="flow-step-row"
                                key={step.stepId}
                            >
                                <div>
                                    <strong>{step.label}</strong>
                                    <small>
                                        {step.stepId} - {step.kind}
                                    </small>
                                </div>
                                <span
                                    className={`pill ${status === 'completed' ? 'good' : statusTone(status)}`}
                                >
                                    {status}
                                </span>
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
                                {(step.expect !== undefined ||
                                    step.extract !== undefined) && (
                                    <pre className="mini-json">
                                            {redactedJson(
                                                {
                                                    expect: step.expect,
                                                    extract: step.extract,
                                                },
                                                state,
                                                authSession,
                                            )}
                                    </pre>
                                )}
                            </article>
                        );
                    })}
                </div>
            </section>
            <section className="flow-builder-preview">
                <div className="section-heading">
                    <h3>SPA Recipe Preview</h3>
                    <span>{recipe?.recipeId ?? '-'}</span>
                </div>
                <pre className="json-block">{recipeText}</pre>
                {recipeValidation && <SchemaAuthoringPanel validation={recipeValidation} />}
            </section>
            <section className="flow-builder-preview">
                <div className="section-heading">
                    <h3>Runner Scenario Preview</h3>
                    <span>black-box-runner</span>
                </div>
                <pre className="json-block">{runnerText}</pre>
                {runnerValidation && <SchemaAuthoringPanel validation={runnerValidation} />}
            </section>
        </div>
    );
}

function toFlowStepCommandIds(
    recipeCommands: readonly RallarBlackBoxTestCommand[],
    stepId: string
): readonly string[] {
    return recipeCommands
        .filter((command) => decodeRecord(command.metadata?.flow).stepId === stepId)
        .map((command, index) => command.commandId ?? `${command.kind}-${index + 1}`);
}
