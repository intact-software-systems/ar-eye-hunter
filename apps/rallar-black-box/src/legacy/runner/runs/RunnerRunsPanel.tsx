import type { AuthSession } from '@shared/api/api-config.ts';
import { ReportPanel } from '../advanced/ReportPanel.tsx';
import { CausalTrailPanel } from '../evidence/CausalTrailPanel.tsx';
import { RtcPerformancePanel } from '../evidence/rtc/RtcPerformancePanel.tsx';
import { RunVerdictPanel } from '../evidence/RunVerdictPanel.tsx';
import { FailurePanel } from './FailurePanel.tsx';
import { RunnerDistributedAnalysisSection } from './RunnerDistributedAnalysisSection.tsx';
import { RunnerLocalRunsSection } from './RunnerLocalRunsSection.tsx';
import { useRunnerRunsController, type UseRunnerRunsControllerInput } from './use-runner-runs-controller.ts';

export { FailurePanel } from './FailurePanel.tsx';

type RunnerRunsPanelProps = UseRunnerRunsControllerInput & {
    authSession?: AuthSession;
};

export function RunnerRunsPanel({
    state,
    bootstrap,
    control,
    authSession,
    preferredDistributedRun
}: RunnerRunsPanelProps) {
    const {
        runLabel,
        runVerdict,
        rtcPerformance,
        selectedDistributedRun,
        distributedBusy,
        activeSyntheticSeed,
        selectedSyntheticSeedId,
        selectSyntheticDistributedRunSeed,
        controlBaseUrl,
        setControlBaseUrl,
        controlToken,
        setControlToken,
        selectedDistributedRunId,
        selectDistributedRun,
        distributedRuns,
        refreshDistributedAnalysis,
        artifactBundle,
        loadDistributedArtifact,
        copyDistributedArtifact,
        handleDistributedArtifactFiles,
        clearSyntheticDistributedRunSeed,
        lastDistributedRefresh,
        controlRunId,
        distributedError,
        runParticipantRows,
        runParticipantSummary,
        analysisReport,
        importedArtifactAnalysis,
        importedArtifactStatus,
        selectedMonitor,
        compareLeftId,
        compareRightId,
        compareSummary,
        setCompareLeftId,
        setCompareRightId,
        history,
        failures,
        latestStats,
        recentHistory
    } = useRunnerRunsController({
        state,
        bootstrap,
        control,
        preferredDistributedRun
    });

    return (
        <section className="panel runner-runs-panel">
            <div className="panel-heading">
                <h2>Runs</h2>
                <span>{runLabel}</span>
            </div>
            <RunVerdictPanel view={runVerdict} />
            <CausalTrailPanel items={runVerdict.causalTrail} />
            <RtcPerformancePanel view={rtcPerformance} compact />
            <RunnerDistributedAnalysisSection
                selectedDistributedRun={selectedDistributedRun}
                distributedBusy={distributedBusy}
                activeSyntheticSeed={activeSyntheticSeed}
                selectedSyntheticSeedId={selectedSyntheticSeedId}
                selectSyntheticDistributedRunSeed={selectSyntheticDistributedRunSeed}
                controlBaseUrl={controlBaseUrl}
                setControlBaseUrl={setControlBaseUrl}
                controlToken={controlToken}
                setControlToken={setControlToken}
                selectedDistributedRunId={selectedDistributedRunId}
                selectDistributedRun={selectDistributedRun}
                distributedRuns={distributedRuns}
                refreshDistributedAnalysis={() => void refreshDistributedAnalysis()}
                artifactBundle={artifactBundle}
                loadDistributedArtifact={() => void loadDistributedArtifact()}
                copyDistributedArtifact={() => void copyDistributedArtifact()}
                handleDistributedArtifactFiles={(event) => void handleDistributedArtifactFiles(event)}
                clearSyntheticDistributedRunSeed={clearSyntheticDistributedRunSeed}
                lastDistributedRefresh={lastDistributedRefresh}
                controlRunId={controlRunId}
                distributedError={distributedError}
                runParticipantRows={runParticipantRows}
                runParticipantSummary={runParticipantSummary}
                analysisReport={analysisReport}
                importedArtifactAnalysis={importedArtifactAnalysis}
                importedArtifactStatus={importedArtifactStatus}
                selectedMonitor={selectedMonitor}
                compareLeftId={compareLeftId}
                compareRightId={compareRightId}
                compareSummary={compareSummary}
                setCompareLeftId={setCompareLeftId}
                setCompareRightId={setCompareRightId}
            />
            <RunnerLocalRunsSection
                runtimeStatus={state.status}
                commandCount={history.length}
                failureCount={failures.length}
                eventCount={state.events.length}
                latestStats={latestStats}
                controlState={control.state}
                recentHistory={recentHistory}
                failurePanel={<FailurePanel state={state} authSession={authSession} />}
                reportPanel={<ReportPanel state={state} authSession={authSession} />}
            />
        </section>
    );
}
