import type { FlowBuilderStepKind } from '../../../flow-builder/flow-builder-contracts.ts';
import { FLOW_BUILDER_TEMPLATES } from '../../../flow-builder/flow-builder-templates.ts';
import type { FlowBuilderControllerModel } from './use-flow-builder-controller.ts';

interface FlowBuilderEditorProps {
    readonly model: FlowBuilderControllerModel;
    readonly busy: boolean;
}

const FLOW_STEP_BUTTONS: readonly FlowBuilderStepKind[] = [
    'auth.login',
    'rest.request',
    'ws.open',
    'ws.send',
    'rtc.connect',
    'rtc.send',
    'wait',
    'cleanup'
];

export function FlowBuilderEditor({ model, busy }: FlowBuilderEditorProps) {
    return (
        <>
            <FlowBuilderToolbar model={model} busy={busy} />
            <div className="flow-builder-add-grid" aria-label="Add flow step">
                {FLOW_STEP_BUTTONS.map((kind) => (
                    <button
                        key={kind}
                        type="button"
                        onClick={() => model.addStep(kind)}
                        disabled={busy}
                    >
                        Add {kind}
                    </button>
                ))}
            </div>
            <FlowBuilderJsonEditors model={model} busy={busy} />
        </>
    );
}

function FlowBuilderToolbar({ model, busy }: FlowBuilderEditorProps) {
    const { recipe, runnerScenario, copyText } = model;
    return (
        <div className="flow-builder-toolbar">
            <label className="field">
                <span>Template</span>
                <select
                    value={model.templateId}
                    onChange={(event) => model.selectTemplate(event.target.value)}
                    disabled={busy}
                >
                    {FLOW_BUILDER_TEMPLATES.map((template) => (
                        <option key={template.templateId} value={template.templateId}>
                            {template.label}
                        </option>
                    ))}
                </select>
            </label>
            <button type="button" onClick={model.normalizeFlowJson}>
                Normalize JSON
            </button>
            <button type="button" onClick={() => void model.runFlow()} disabled={busy || !recipe}>
                Run Flow
            </button>
            <button type="button" onClick={() => void copyText(model.recipeText)} disabled={!recipe}>
                Copy SPA Recipe
            </button>
            <button type="button" onClick={() => void copyText(model.runnerText)} disabled={!runnerScenario}>
                Copy Runner Scenario
            </button>
        </div>
    );
}

function FlowBuilderJsonEditors({ model, busy }: FlowBuilderEditorProps) {
    return (
        <div className="flow-builder-editors">
            <label className="json-editor">
                <span>Variables JSON</span>
                <textarea
                    value={model.variablesText}
                    onChange={(event) => {
                        model.setVariablesEdited(true);
                        model.setVariablesText(event.target.value);
                    }}
                    spellCheck={false}
                    disabled={busy}
                />
            </label>
            <label className="json-editor">
                <span>Flow JSON</span>
                <textarea
                    value={model.flowText}
                    onChange={(event) => model.setFlowText(event.target.value)}
                    spellCheck={false}
                    disabled={busy}
                />
            </label>
        </div>
    );
}
