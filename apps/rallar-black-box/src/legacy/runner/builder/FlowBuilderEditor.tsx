import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';
import { FLOW_BUILDER_TEMPLATES, type FlowBuilderStepKind } from '../../../flow-builder.ts';
import { FLOW_STEP_BUTTONS } from './flow-builder-support.ts';

type FlowBuilderEditorProps = Readonly<{
    templateId: string;
    selectTemplate(value: string): void;
    busy: boolean;
    normalizeFlowJson(): void;
    runFlow(): Promise<void>;
    recipe?: RallarBlackBoxTestRecipe;
    copyText(text: string): void;
    recipeText: string;
    runnerText: string;
    runnerScenario?: Readonly<Record<string, unknown>>;
    addStep(kind: FlowBuilderStepKind): void;
    variablesText: string;
    setVariablesEdited(value: boolean): void;
    setVariablesText(value: string): void;
    flowText: string;
    setFlowText(value: string): void;
}>;

export function FlowBuilderEditor({
    templateId,
    selectTemplate,
    busy,
    normalizeFlowJson,
    runFlow,
    recipe,
    copyText,
    recipeText,
    runnerText,
    runnerScenario,
    addStep,
    variablesText,
    setVariablesEdited,
    setVariablesText,
    flowText,
    setFlowText
}: FlowBuilderEditorProps) {
    return (
        <>
            <div className="flow-builder-toolbar">
                <label className="field">
                    <span>Template</span>
                    <select
                        value={templateId}
                        onChange={(event) => selectTemplate(event.target.value)}
                        disabled={busy}
                    >
                        {FLOW_BUILDER_TEMPLATES.map((template) => (
                            <option
                                key={template.templateId}
                                value={template.templateId}
                            >
                                {template.label}
                            </option>
                        ))}
                    </select>
                </label>
                <button type="button" onClick={normalizeFlowJson}>
                    Normalize JSON
                </button>
                <button
                    type="button"
                    onClick={() => void runFlow()}
                    disabled={busy || !recipe}
                >
                    Run Flow
                </button>
                <button
                    type="button"
                    onClick={() => copyText(recipeText)}
                    disabled={!recipe}
                >
                    Copy SPA Recipe
                </button>
                <button
                    type="button"
                    onClick={() => copyText(runnerText)}
                    disabled={!runnerScenario}
                >
                    Copy Runner Scenario
                </button>
            </div>
            <div className="flow-builder-add-grid" aria-label="Add flow step">
                {FLOW_STEP_BUTTONS.map((kind) => (
                    <button
                        key={kind}
                        type="button"
                        onClick={() => addStep(kind)}
                        disabled={busy}
                    >
                        Add {kind}
                    </button>
                ))}
            </div>
            <div className="flow-builder-editors">
                <label className="json-editor">
                    <span>Variables JSON</span>
                    <textarea
                        value={variablesText}
                        onChange={(event) => {
                            setVariablesEdited(true);
                            setVariablesText(event.target.value);
                        }}
                        spellCheck={false}
                        disabled={busy}
                    />
                </label>
                <label className="json-editor">
                    <span>Flow JSON</span>
                    <textarea
                        value={flowText}
                        onChange={(event) => setFlowText(event.target.value)}
                        spellCheck={false}
                        disabled={busy}
                    />
                </label>
            </div>
        </>
    );
}
