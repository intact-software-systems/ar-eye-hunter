import { Activity } from 'react';
import { EventStreamPanel } from '../../diagnostics/events/EventStreamPanel.tsx';
import { ExecutionFocusPanel } from '../../diagnostics/events/ExecutionFocusPanel.tsx';
import { RallarTracePanel } from '../../diagnostics/events/RallarTracePanel.tsx';
import { StatsPanel } from '../../diagnostics/events/StatsPanel.tsx';
import { RallarServerPanel } from '../../diagnostics/rallar-server/rallar-server-panel.tsx';
import { CommandHistoryPanel } from '../../runner/advanced/CommandHistoryPanel.tsx';
import { FailurePanel } from '../../runner/runs/FailurePanel.tsx';
import { uiRedactionOptions } from '../../shared/redaction-presentation.ts';
import type {
    LegacyShellAuth,
    LegacyShellGlobalContext,
    LegacyShellNavigation,
    LegacyShellRunnerSelection,
    LegacyShellRuntime
} from '../legacy-shell-contracts.ts';

export function DiagnosticEvidenceTabPanels({
    runtime,
    auth,
    navigation,
    globalContext,
    runnerSelection
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
        selectedResult
    } = runnerSelection;

    // The trace and event panels render the run's events, and the state changes with each one: hidden, they keep their
    // state but render only when the page is otherwise idle.
    return (
        <>
            <section
                id="panel-rallar-trace"
                className="workspace-grid tab-workspace rallar-trace-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-rallar-trace"
                hidden={activeTab !== 'rallar-trace'}
            >
                <Activity mode={activeTab === 'rallar-trace' ? 'visible' : 'hidden'}>
                    <RallarTracePanel state={state} authSession={authSession} />
                </Activity>
            </section>
            <section
                id="panel-event-stream"
                className="workspace-grid tab-workspace events-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-event-stream"
                hidden={activeTab !== 'event-stream'}
            >
                <Activity mode={activeTab === 'event-stream' ? 'visible' : 'hidden'}>
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
                </Activity>
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
