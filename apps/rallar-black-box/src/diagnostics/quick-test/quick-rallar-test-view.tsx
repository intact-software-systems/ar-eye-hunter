import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { CommandCenterGlobalValues } from '../../legacy/shell/global-context-model.ts';
import type { RallarBrowserStatusSummary } from '../../legacy/shell/rallar-browser-status.ts';
import type { QuickRallarTestViewModel } from './quick-rallar-contracts.ts';
import { QuickRallarTestActionSection } from './quick-rallar-test-action-section.tsx';
import { QuickRallarTestDiagnosticsSection } from './quick-rallar-test-diagnostics-section.tsx';
import { QuickRallarTestInputSection } from './quick-rallar-test-input-section.tsx';
import { QuickRallarTestStatusSection } from './quick-rallar-test-status-section.tsx';

interface QuickRallarTestViewProps {
    readonly state: RallarBlackBoxTestState;
    readonly authSession?: AuthSession;
    readonly globalValues: CommandCenterGlobalValues;
    readonly browserStatus: RallarBrowserStatusSummary;
    readonly model: QuickRallarTestViewModel;
    onOpenAuth(): void;
    onOpenRunnerMode(): void;
}

export function QuickRallarTestView(
    { state, authSession, globalValues, browserStatus, model, onOpenAuth, onOpenRunnerMode }: QuickRallarTestViewProps
) {
    return (
        <section className="panel quick-rallar-test-panel" aria-label="Rallar Quick Test">
            <QuickRallarTestStatusSection
                authSession={authSession}
                globalValues={globalValues}
                browserStatus={browserStatus}
                model={model}
            />
            <QuickRallarTestInputSection groupId={globalValues.roomId} model={model} />
            <QuickRallarTestActionSection
                authSession={authSession}
                model={model}
                onOpenAuth={onOpenAuth}
                onOpenRunnerMode={onOpenRunnerMode}
            />
            <QuickRallarTestDiagnosticsSection state={state} authSession={authSession} model={model} />
            {(!model.realBackendReady || !authSession || model.localError || !model.payloadResult.ok ||
                model.busyAction) && (
                <div
                    className={model.localError || !model.payloadResult.ok
                        ? 'workbench-error'
                        : 'command-center-status'}
                    role="status"
                >
                    {model.localError ?? (!model.payloadResult.ok
                        ? model.payloadResult.error
                        : !model.realBackendReady
                        ? 'Quick Test requires provider=browser-rallar.'
                        : !authSession
                        ? 'Quick Test requires a logged-in browser session.'
                        : model.busyAction)}
                </div>
            )}
        </section>
    );
}
