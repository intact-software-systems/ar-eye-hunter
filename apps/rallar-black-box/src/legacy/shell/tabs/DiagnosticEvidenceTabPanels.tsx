import { EventStreamPanel } from '../../diagnostics/events/EventStreamPanel.tsx';
import { ExecutionFocusPanel } from '../../diagnostics/events/ExecutionFocusPanel.tsx';
import { RallarTracePanel } from '../../diagnostics/events/RallarTracePanel.tsx';
import { StatsPanel } from '../../diagnostics/events/StatsPanel.tsx';
import { RallarServerPanel } from '../../diagnostics/rallar-server/RallarServerPanel.tsx';
import { CommandHistoryPanel } from '../../runner/advanced/CommandHistoryPanel.tsx';
import { FailurePanel } from '../../runner/runs/FailurePanel.tsx';
import { uiRedactionOptions } from '../../shared/redaction-presentation.ts';
import type {
    LegacyShellAuth,
    LegacyShellGlobalContext,
    LegacyShellNavigation,
    LegacyShellRunnerSelection,
    LegacyShellRuntime,
} from '../legacy-shell-contracts.ts';

export function DiagnosticEvidenceTabPanels({
    runtime,
    auth,
    navigation,
    globalContext,
    runnerSelection,
}: Readonly<{
    runtime: LegacyShellRuntime;
    auth: LegacyShellAuth;
    navigation: LegacyShellNavigation;
    globalContext: LegacyShellGlobalContext;
    runnerSelection: LegacyShellRunnerSelection;
}>) {
    const { state, bootstrap, control } = runtime;
    const { authSession } = auth;
    const { activeTab } = navigation;
    const { globalValues, updateGlobalValue } = globalContext;
    const {
        history,
        activeCommand,
        now,
        selectedCommandId,
        setSelectedCommandId,
        selectedResult,
    } = runnerSelection;

    return (
        <>
            <section
                id="panel-rallar-trace"
                className="workspace-grid tab-workspace rallar-trace-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-rallar-trace"
                hidden={activeTab !== 'rallar-trace'}
            >
                <RallarTracePanel state={state} authSession={authSession} />
            </section>
            <section
                id="panel-event-stream"
                className="workspace-grid tab-workspace events-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-event-stream"
                hidden={activeTab !== 'event-stream'}
            >
                <ExecutionFocusPanel
                    result={selectedResult}
                    activeCommand={activeCommand}
                    startedAtEpochMs={state.activeCommandStartedAtEpochMs}
                    now={now}
                    redactionOptions={uiRedactionOptions(state, authSession)}
                />
                <CommandHistoryPanel
                    history={history}
                    selectedCommandId={selectedCommandId}
                    onSelect={setSelectedCommandId}
                />
                <StatsPanel state={state} />
                <FailurePanel state={state} authSession={authSession} />
                <EventStreamPanel state={state} />
            </section>
            <section
                id="panel-rallar-server"
                className="workspace-grid tab-workspace server-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-rallar-server"
                hidden={activeTab !== 'rallar-server'}
            >
                <RallarServerPanel
                    state={state}
                    bootstrap={bootstrap}
                    authSession={authSession}
                    globalValues={globalValues}
                    control={control}
                    onGlobalValueChange={updateGlobalValue}
                />
            </section>
        </>
    );
}
