import type { ChangeEvent } from 'react';
import type { DistributedRunAnalysis } from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import type {
    ControlAgentBoardRow,
    ControlAgentBoardSummary,
} from '../../../control-agent-board.ts';
import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
} from '../../../control-run-manager.ts';
import {
    distributedRecipeStateTone,
    type DistributedRunAnalysisReport,
    type DistributedRunCompareSummary,
    type DistributedRunMonitor,
} from '../../../distributed-recipes.ts';
import {
    DISTRIBUTED_RUN_SEEDS,
    type DistributedRunSeedId,
    type SyntheticDistributedRunSeed,
} from '../../../distributed-run-seeds.ts';
import { formatTime } from '../../shared/time-format.ts';
import { ControlAgentBoardPanel } from '../agents/ControlAgentBoardPanel.tsx';
import { DistributedRunComparePanel } from '../distributed/DistributedRunComparePanel.tsx';
import { DistributedRunMonitorPanel } from '../distributed/DistributedRunMonitorPanel.tsx';
import { DistributedRunSummary } from '../distributed/DistributedRunSummary.tsx';
import { DistributedRunAnalysisReportPanel } from './DistributedRunAnalysisReportPanel.tsx';
import { ImportedDistributedArtifactAnalysisPanel } from './ImportedDistributedArtifactAnalysisPanel.tsx';
import type { DistributedArtifactImportStatus } from './distributed-artifact-import.ts';

type RunnerDistributedAnalysisSectionProps = Readonly<{
    selectedDistributedRun?: ControlDistributedRunSnapshot;
    distributedBusy?: string;
    activeSyntheticSeed?: SyntheticDistributedRunSeed;
    selectedSyntheticSeedId: DistributedRunSeedId | '';
    selectSyntheticDistributedRunSeed(value: string): void;
    controlBaseUrl: string;
    setControlBaseUrl(value: string): void;
    controlToken: string;
    setControlToken(value: string): void;
    selectedDistributedRunId: string;
    selectDistributedRun(value: string): void;
    distributedRuns: readonly ControlDistributedRunSnapshot[];
    refreshDistributedAnalysis(): void;
    artifactBundle?: ControlDistributedRunArtifactBundle;
    loadDistributedArtifact(): void;
    copyDistributedArtifact(): void;
    handleDistributedArtifactFiles(event: ChangeEvent<HTMLInputElement>): void;
    clearSyntheticDistributedRunSeed(): void;
    lastDistributedRefresh?: number;
    controlRunId: string;
    distributedError?: string;
    runParticipantRows: readonly ControlAgentBoardRow[];
    runParticipantSummary: ControlAgentBoardSummary;
    analysisReport?: DistributedRunAnalysisReport;
    importedArtifactAnalysis?: DistributedRunAnalysis;
    importedArtifactStatus?: DistributedArtifactImportStatus;
    selectedMonitor?: DistributedRunMonitor;
    compareLeftId: string;
    compareRightId: string;
    compareSummary?: DistributedRunCompareSummary;
    setCompareLeftId(value: string): void;
    setCompareRightId(value: string): void;
}>;

export function RunnerDistributedAnalysisSection({
    selectedDistributedRun, distributedBusy, activeSyntheticSeed,
    selectedSyntheticSeedId, selectSyntheticDistributedRunSeed,
    controlBaseUrl, setControlBaseUrl, controlToken, setControlToken,
    selectedDistributedRunId, selectDistributedRun, distributedRuns,
    refreshDistributedAnalysis, artifactBundle, loadDistributedArtifact,
    copyDistributedArtifact, handleDistributedArtifactFiles,
    clearSyntheticDistributedRunSeed, lastDistributedRefresh, controlRunId,
    distributedError, runParticipantRows, runParticipantSummary,
    analysisReport, importedArtifactAnalysis, importedArtifactStatus,
    selectedMonitor, compareLeftId, compareRightId, compareSummary,
    setCompareLeftId, setCompareRightId,
}: RunnerDistributedAnalysisSectionProps) {
    return (
            <section className="runner-distributed-analysis">
                <div className="section-heading">
                    <h3>Distributed Analysis</h3>
                    <span
                        className={`pill ${selectedDistributedRun ? distributedRecipeStateTone(selectedDistributedRun.state) : 'muted'}`}
                    >
                        {distributedBusy ??
                            selectedDistributedRun?.state ??
                            'no run'}
                    </span>
                </div>
                {activeSyntheticSeed && (
                    <div className="synthetic-seed-notice" role="status">
                        <span className="pill warn">Synthetic evidence</span>
                        <strong>{activeSyntheticSeed.label}</strong>
                        <span>{activeSyntheticSeed.description}</span>
                    </div>
                )}
                <div className="runner-distributed-toolbar">
                    <label className="field synthetic-seed-control">
                        <span>Synthetic seed</span>
                        <select
                            value={selectedSyntheticSeedId}
                            onChange={(event) =>
                                selectSyntheticDistributedRunSeed(
                                    event.target.value,
                                )}
                        >
                            <option value="">Real control data</option>
                            {DISTRIBUTED_RUN_SEEDS.map((seed) => (
                                <option key={seed.id} value={seed.id}>
                                    {seed.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>Control HTTP</span>
                        <input
                            disabled={Boolean(activeSyntheticSeed)}
                            value={controlBaseUrl}
                            onChange={(event) =>
                                setControlBaseUrl(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Token</span>
                        <input
                            type="password"
                            autoComplete="off"
                            disabled={Boolean(activeSyntheticSeed)}
                            value={controlToken}
                            onChange={(event) =>
                                setControlToken(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Distributed Run</span>
                        <select
                            disabled={Boolean(activeSyntheticSeed)}
                            value={selectedDistributedRunId}
                            onChange={(event) =>
                                selectDistributedRun(event.target.value)
                            }
                        >
                            <option value="">Latest run</option>
                            {distributedRuns.map((run) => (
                                <option
                                    key={run.distributedRunId}
                                    value={run.distributedRunId}
                                >
                                    {run.distributedRunId}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        type="button"
                        disabled={Boolean(distributedBusy) || Boolean(activeSyntheticSeed)}
                        onClick={() => void refreshDistributedAnalysis()}
                    >
                        Refresh
                    </button>
                    <button
                        type="button"
                        disabled={
                            Boolean(distributedBusy) ||
                            (Boolean(activeSyntheticSeed) && !artifactBundle) ||
                            !selectedDistributedRun
                        }
                        onClick={() => void loadDistributedArtifact()}
                    >
                        Export artifact
                    </button>
                    <button
                        type="button"
                        disabled={!artifactBundle}
                        onClick={() => void copyDistributedArtifact()}
                    >
                        Copy artifact
                    </button>
                    <label className="field distributed-artifact-import-field">
                        <span>Import CI artifact</span>
                        <input
                            type="file"
                            multiple
                            accept=".json,.jsonl,application/json"
                            {...({ webkitdirectory: 'true' } as Record<string, string>)}
                            disabled={Boolean(distributedBusy)}
                            onChange={(event) =>
                                void handleDistributedArtifactFiles(event)}
                        />
                        <small>
                            Select the artifact directory, or select all JSON and JSONL files from it.
                        </small>
                    </label>
                    {activeSyntheticSeed && (
                        <button
                            type="button"
                            onClick={clearSyntheticDistributedRunSeed}
                        >
                            Clear seed
                        </button>
                    )}
                </div>
                <div className="runner-distributed-freshness">
                    <span>
                        {lastDistributedRefresh
                            ? `Fresh ${formatTime(lastDistributedRefresh)}`
                            : 'Not refreshed yet'}
                    </span>
                    <span>{controlRunId || 'no control run'}</span>
                </div>
                {distributedError && (
                    <div className="workbench-error" role="status">
                        {distributedError}
                    </div>
                )}
                {!selectedDistributedRun && !distributedError && (
                    <div className="empty-state">
                        No distributed run selected. Start a recipe on connected
                        agents or refresh the control server.
                    </div>
                )}
                {selectedDistributedRun && (
                    <DistributedRunSummary run={selectedDistributedRun} />
                )}
                {selectedDistributedRun && (
                    <ControlAgentBoardPanel
                        title="Run Participants"
                        subtitle={`${selectedDistributedRun.distributedRunId} participants and live control-agent status`}
                        rows={runParticipantRows}
                        summary={runParticipantSummary}
                        emptyMessage="No target agents recorded for the selected distributed run."
                        compact
                    />
                )}
                {analysisReport && (
                    <DistributedRunAnalysisReportPanel
                        report={analysisReport}
                    />
                )}
                {importedArtifactAnalysis && (
                    <ImportedDistributedArtifactAnalysisPanel
                        analysis={importedArtifactAnalysis}
                        status={importedArtifactStatus}
                    />
                )}
                {selectedMonitor && (
                    <DistributedRunMonitorPanel monitor={selectedMonitor} />
                )}
                {distributedRuns.length > 1 && (
                    <DistributedRunComparePanel
                        runs={distributedRuns}
                        leftId={compareLeftId}
                        rightId={compareRightId}
                        summary={compareSummary}
                        onLeftChange={setCompareLeftId}
                        onRightChange={setCompareRightId}
                    />
                )}
            </section>
    );
}
