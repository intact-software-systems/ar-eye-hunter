import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import { uiRedactionOptions } from '../../shared/redaction-presentation.ts';
import { ManualRallarExecutionPanel } from './manual-rallar-execution-panel.tsx';
import { ManualRallarInputsPanel } from './manual-rallar-inputs-panel.tsx';
import type { ManualRallarWorkbenchOptions } from './manual-rallar-workbench-options.ts';
import { useManualRallarWorkbench } from './use-manual-rallar-workbench.ts';

export interface ManualRallarWorkbenchPanelProps extends ManualRallarWorkbenchOptions {
    readonly busy: boolean;
}

export function ManualRallarWorkbenchPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
    globalValuesEdited,
    busy,
    onSelectCommand,
    onGlobalValueChange
}: ManualRallarWorkbenchPanelProps) {
    const model = useManualRallarWorkbench({
        state,
        bootstrap,
        authSession,
        globalValues,
        globalValuesEdited,
        onSelectCommand,
        onGlobalValueChange
    });

    return (
        <section className="panel manual-rallar-panel">
            <div className="panel-heading">
                <h2>Manual Rallar</h2>
                <span
                    className={`pill ${model.payloadResult.foldRight(() => 'good') ?? 'bad'}`}
                >
                    {model.payloadResult.foldRight(() => 'json valid') ?? 'json invalid'}
                </span>
            </div>
            <ManualRallarInputsPanel busy={busy} model={model} />
            <ManualRallarExecutionPanel
                state={state}
                authSession={authSession}
                busy={busy}
                onSelectCommand={onSelectCommand}
                model={model}
            />
            {model.localError && (
                <div className="workbench-error" role="status">
                    {redactRallarBlackBoxValue(
                        model.localError,
                        uiRedactionOptions(state, authSession, [
                            model.values.rallarPassword
                        ])
                    )}
                </div>
            )}
        </section>
    );
}
