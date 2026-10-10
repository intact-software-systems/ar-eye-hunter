import type { AuthSession } from '@shared/api/api-config.ts';

import { ReportPanel } from '../advanced/report-panel.tsx';
import { CausalTrailPanel } from '../evidence/CausalTrailPanel.tsx';
import { RtcPerformancePanel } from '../evidence/rtc/RtcPerformancePanel.tsx';
import { RunVerdictPanel } from '../evidence/RunVerdictPanel.tsx';
import { FailurePanel } from './FailurePanel.tsx';
import { RunnerDistributedAnalysisSection } from './RunnerDistributedAnalysisSection.tsx';
import { RunnerLocalRunsSection } from './RunnerLocalRunsSection.tsx';
import { useRunnerRunsController, type UseRunnerRunsControllerInput } from './use-runner-runs-controller.ts';

interface RunnerRunsPanelProps extends UseRunnerRunsControllerInput {
    readonly authSession?: AuthSession;
}

export function RunnerRunsPanel(
    { state, bootstrap, control, authSession, preferredDistributedRun }: RunnerRunsPanelProps
) {
    const controller = useRunnerRunsController({ state, bootstrap, control, preferredDistributedRun });
    return (
        <section className="panel runner-runs-panel">
            <div className="panel-heading">
                <h2>Runs</h2>
                <span>{controller.runLabel}</span>
            </div>
            <RunVerdictPanel view={controller.runVerdict} />
            <CausalTrailPanel items={controller.runVerdict.causalTrail} />
            <RtcPerformancePanel view={controller.rtcPerformance} compact />
            <RunnerDistributedAnalysisSection {...controller} />
            <RunnerLocalRunsSection
                runtimeStatus={state.status}
                commandCount={controller.history.length}
                failureCount={controller.failures.length}
                eventCount={state.events.length}
                latestStats={controller.latestStats}
                controlState={control.state}
                recentHistory={controller.recentHistory}
                failurePanel={<FailurePanel state={state} authSession={authSession} />}
                reportPanel={<ReportPanel active={true} state={state} authSession={authSession} />}
            />
        </section>
    );
}
