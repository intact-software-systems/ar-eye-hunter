import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import { uiRedactionOptions } from '../../shared/redaction-presentation.ts';
import { FlowBuilderEditor } from './flow-builder-editor.tsx';
import { FlowBuilderPreviews } from './flow-builder-previews.tsx';
import { useFlowBuilderController, type UseFlowBuilderControllerInput } from './use-flow-builder-controller.ts';

interface FlowBuilderPanelProps extends UseFlowBuilderControllerInput {
    readonly busy: boolean;
}

export function FlowBuilderPanel(props: FlowBuilderPanelProps) {
    const { state, authSession, busy } = props;
    const model = useFlowBuilderController(props);
    const { parseError, localError, recipe } = model;
    return (
        <section className="panel flow-builder-panel">
            <div className="panel-heading">
                <h2>Flow Builder</h2>
                <span className={`pill ${parseError ? 'bad' : 'good'}`}>
                    {parseError ? 'invalid' : `${recipe?.commands.length ?? 0} commands`}
                </span>
            </div>
            <FlowBuilderEditor model={model} busy={busy} />
            {(parseError || localError) && (
                <div className="workbench-error" role="status">
                    {redactRallarBlackBoxValue(localError ?? parseError, uiRedactionOptions(state, authSession))}
                </div>
            )}
            <FlowBuilderPreviews
                model={model}
                state={state}
                authSession={authSession}
                onSelectCommand={props.onSelectCommand}
            />
        </section>
    );
}
