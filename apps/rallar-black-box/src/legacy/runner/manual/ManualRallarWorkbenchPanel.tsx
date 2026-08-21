import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { uiRedactionOptions } from '../../shared/redaction-presentation.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { ManualRallarExecutionPanel } from './ManualRallarExecutionPanel.tsx';
import { ManualRallarInputsPanel } from './ManualRallarInputsPanel.tsx';
import { useManualRallarWorkbench } from './use-manual-rallar-workbench.ts';

export function ManualRallarWorkbenchPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
    globalValuesEdited,
    busy,
    onSelectCommand,
    onGlobalValueChange
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    globalValuesEdited?: boolean;
    busy: boolean;
    onSelectCommand(commandId: string): void;
    onGlobalValueChange?<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K]
    ): void;
}) {
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
                    className={`pill ${model.payloadResult.ok ? 'good' : 'bad'}`}
                >
                    {model.payloadResult.ok ? 'json valid' : 'json invalid'}
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
