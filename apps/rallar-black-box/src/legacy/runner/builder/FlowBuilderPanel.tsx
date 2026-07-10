import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import { uiRedactionOptions } from '../../shared/redaction-presentation.ts';
import { FlowBuilderEditor } from './FlowBuilderEditor.tsx';
import { FlowBuilderPreviews } from './FlowBuilderPreviews.tsx';
import {
    type UseFlowBuilderControllerInput,
    useFlowBuilderController,
} from './use-flow-builder-controller.ts';

type FlowBuilderPanelProps = UseFlowBuilderControllerInput & {
    busy: boolean;
};

export function FlowBuilderPanel({
    state,
    authSession,
    globalValues,
    busy,
    onSelectCommand,
}: FlowBuilderPanelProps) {
    const {
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
    } = useFlowBuilderController({
        state,
        authSession,
        globalValues,
        onSelectCommand,
    });
    return (
        <section className="panel flow-builder-panel">
            <div className="panel-heading">
                <h2>Flow Builder</h2>
                <span className={`pill ${parseError ? 'bad' : 'good'}`}>
                    {parseError
                        ? 'invalid'
                        : `${recipe?.commands.length ?? 0} commands`}
                </span>
            </div>
            <FlowBuilderEditor
                templateId={templateId}
                selectTemplate={selectTemplate}
                busy={busy}
                normalizeFlowJson={normalizeFlowJson}
                runFlow={runFlow}
                recipe={recipe}
                copyText={copyText}
                recipeText={recipeText}
                runnerText={runnerText}
                runnerScenario={runnerScenario}
                addStep={addStep}
                variablesText={variablesText}
                setVariablesEdited={setVariablesEdited}
                setVariablesText={setVariablesText}
                flowText={flowText}
                setFlowText={setFlowText}
            />
            {(parseError || localError) && (
                <div className="workbench-error" role="status">
                    {redactRallarBlackBoxValue(
                        localError ?? parseError,
                        uiRedactionOptions(state, authSession),
                    )}
                </div>
            )}
            <FlowBuilderPreviews
                flow={flow}
                recipe={recipe}
                state={state}
                authSession={authSession}
                onSelectCommand={onSelectCommand}
                recipeText={recipeText}
                recipeValidation={recipeValidation}
                runnerText={runnerText}
                runnerValidation={runnerValidation}
            />
        </section>
    );
}
