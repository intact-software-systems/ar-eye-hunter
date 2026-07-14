import { distributedRecipeStateTone } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
} from '../../../../control-run-manager.ts';
import { Metric } from '../../../shared/Metric.tsx';
import { formatTime } from '../../../shared/time-format.ts';
import { DistributedRunSummary } from '../../distributed/DistributedRunSummary.tsx';

type DistributedRunControlPanelProps = Readonly<{
    busy: boolean;
    manifestValidation?: string;
    worldFleetBlockReason?: string;
    distributedRunId: string;
    selectedDistributedRun?: ControlDistributedRunSnapshot;
    currentDistributedRuns: readonly ControlDistributedRunSnapshot[];
    artifactBundle?: ControlDistributedRunArtifactBundle;
    onDistributedRunIdChange(value: string): void;
    onGenerateNewRunId(): void;
    onCreateRun(): void | Promise<void>;
    onStageRun(): void | Promise<void>;
    onStartRun(): void | Promise<void>;
    onCancelRun(): void | Promise<void>;
    onLoadArtifact(): void | Promise<void>;
    onCopyArtifact(): void | Promise<void>;
    onLoadDistributedRun(id: string): void | Promise<void>;
}>;

export function DistributedRunControlPanel(props: DistributedRunControlPanelProps) {
    return (
        <section className="distributed-subpanel">
            <div className="section-heading">
                <h3>Run Control</h3>
                <span
                    className={`pill ${distributedRecipeStateTone(props.selectedDistributedRun?.state ?? 'draft')}`}
                >
                    {props.selectedDistributedRun?.state ?? 'draft'}
                </span>
            </div>
            <div className="distributed-run-id-row">
                <label className="field">
                    <span>Distributed Run ID</span>
                    <input
                        value={props.distributedRunId}
                        onChange={(event) =>
                            props.onDistributedRunIdChange(event.target.value)
                        }
                    />
                </label>
                <button
                    type="button"
                    onClick={props.onGenerateNewRunId}
                    disabled={props.busy}
                >
                    New ID
                </button>
            </div>
            <div className="distributed-action-grid">
                <button
                    type="button"
                    disabled={props.busy || Boolean(props.manifestValidation)}
                    onClick={() => void props.onCreateRun()}
                >
                    Create
                </button>
                <button
                    type="button"
                    disabled={
                        props.busy ||
                        Boolean(props.manifestValidation) ||
                        Boolean(props.worldFleetBlockReason)
                    }
                    onClick={() => void props.onStageRun()}
                >
                    Stage
                </button>
                <button
                    type="button"
                    disabled={
                        props.busy ||
                        !props.selectedDistributedRun ||
                        Boolean(props.worldFleetBlockReason)
                    }
                    onClick={() => void props.onStartRun()}
                >
                    Start
                </button>
                <button
                    type="button"
                    disabled={props.busy || !props.selectedDistributedRun}
                    onClick={() => void props.onCancelRun()}
                >
                    Cancel
                </button>
                <button
                    type="button"
                    disabled={props.busy || !props.selectedDistributedRun}
                    onClick={() => void props.onLoadArtifact()}
                >
                    Export artifact
                </button>
                <button
                    type="button"
                    disabled={!props.artifactBundle}
                    onClick={() => void props.onCopyArtifact()}
                >
                    Copy artifact
                </button>
            </div>
            {props.selectedDistributedRun && (
                <DistributedRunSummary run={props.selectedDistributedRun} />
            )}
            <div className="section-heading compact">
                <h3>Distributed Runs</h3>
                <span>{props.currentDistributedRuns.length}</span>
            </div>
            <div className="distributed-run-list">
                {props.currentDistributedRuns.map((item) => (
                    <button
                        type="button"
                        key={item.distributedRunId}
                        className={`distributed-run-row ${item.distributedRunId === props.selectedDistributedRun?.distributedRunId ? 'selected' : ''}`}
                        onClick={() =>
                            void props.onLoadDistributedRun(
                                item.distributedRunId,
                            )
                        }
                    >
                        <span>
                            <strong>{item.distributedRunId}</strong>
                            <small>
                                {item.manifest.displayName ?? item.controlRunId}
                            </small>
                        </span>
                        <span
                            className={`pill ${distributedRecipeStateTone(item.state)}`}
                        >
                            {item.state}
                        </span>
                        <small>{formatTime(item.updatedAtEpochMs)}</small>
                    </button>
                ))}
                {props.currentDistributedRuns.length === 0 && (
                    <div className="empty-state">
                        No distributed runs for selected control run
                    </div>
                )}
            </div>
            {props.artifactBundle && (
                <div className="distributed-artifact-summary">
                    <Metric
                        label="Artifact"
                        value={`schema ${props.artifactBundle.artifactSchemaVersion}`}
                    />
                    <Metric
                        label="Files"
                        value={String(
                            Object.keys(props.artifactBundle.files).length,
                        )}
                        tone="good"
                    />
                    <Metric
                        label="Generated"
                        value={formatTime(
                            props.artifactBundle.generatedAtEpochMs,
                        )}
                    />
                </div>
            )}
        </section>
    );
}
