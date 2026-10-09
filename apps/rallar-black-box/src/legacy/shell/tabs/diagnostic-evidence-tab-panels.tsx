import { Activity } from 'react';

import { EventStreamPanel } from '../../diagnostics/events/event-stream-panel.tsx';
import { ExecutionFocusPanel } from '../../diagnostics/events/ExecutionFocusPanel.tsx';
import { RallarTracePanel } from '../../diagnostics/events/rallar-trace-panel.tsx';
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

interface DiagnosticEvidenceTabPanelsProps {
    readonly runtime: LegacyShellRuntime;
    readonly auth: LegacyShellAuth;
    readonly navigation: LegacyShellNavigation;
    readonly globalContext: LegacyShellGlobalContext;
    readonly runnerSelection: LegacyShellRunnerSelection;
}

export function DiagnosticEvidenceTabPanels(props: DiagnosticEvidenceTabPanelsProps) {
    const { state, bootstrap, control } = props.runtime;
    const { authSession } = props.auth;
    const { activeTab } = props.navigation;
    const { globalValues, updateGlobalValue } = props.globalContext;
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
                    <RallarTracePanel active={activeTab === 'rallar-trace'} state={state} authSession={authSession} />
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
                    <EventStreamEvidence
                        runtime={props.runtime}
                        auth={props.auth}
                        runnerSelection={props.runnerSelection}
                        active={activeTab === 'event-stream'}
                    />
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

function EventStreamEvidence(
    { runtime, auth, runnerSelection, active }:
        & Pick<DiagnosticEvidenceTabPanelsProps, 'runtime' | 'auth' | 'runnerSelection'>
        & { readonly active: boolean; }
) {
    const { state } = runtime;
    const { authSession } = auth;
    const { history, activeCommand, now, selectedCommandId, setSelectedCommandId, selectedResult } = runnerSelection;
    return (
        <>
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
            <EventStreamPanel active={active} state={state} />
        </>
    );
}
