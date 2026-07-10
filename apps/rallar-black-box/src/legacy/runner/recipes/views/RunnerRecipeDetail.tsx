import type { RallarBlackBoxTestResult, RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AppTabId } from '../../../../app-tabs.ts';
import type { ControlDistributedRunArtifactBundle, ControlDistributedRunSnapshot } from '../../../../control-run-manager.ts';
import { distributedRecipeStateTone, type DistributedRecipePreflightSummary } from '../../../../distributed-recipes.ts';
import { runnerFriendlyErrorMessage, type RecipeLaunchState } from '../../../../runner-readiness.ts';
import type { CommandCenterGlobalValues } from '../../../shell/global-context-model.ts';
import { Metric } from '../../../shared/Metric.tsx';
import { resultSummary, statusTone } from '../../../shared/command-presentation.ts';
import { json } from '../../../shared/json-presentation.ts';
import { formatTime } from '../../../shared/time-format.ts';
import { DistributedRecipePreflightPanel } from '../../distributed-recipes/DistributedRecipePreflightPanel.tsx';
import type { RunnerRecipeCatalogEntry } from '../runner-recipe-catalog.ts';
import { runnerLaunchTone } from '../runner-launch-presentation.ts';

type RunnerRecipeDetailProps = Readonly<{
    selectedRecipe?: RunnerRecipeCatalogEntry;
    launchState: RecipeLaunchState;
    localDisabledReason?: string;
    localRunning: boolean;
    distributedDisabledReason?: string;
    runLocalRecipe(): Promise<void>;
    runDistributedRecipe(): Promise<void>;
    controlRunId: string;
    globalValues: CommandCenterGlobalValues;
    recipePreflight?: DistributedRecipePreflightSummary;
    launchMessage: string;
    launchError?: string;
    lastError?: string;
    runState: string;
    history: readonly RallarBlackBoxTestResult[];
    failures: readonly RallarBlackBoxTestResult[];
    latestResult?: RallarBlackBoxTestResult;
    firstFailure?: RallarBlackBoxTestResult;
    distributedRun?: ControlDistributedRunSnapshot;
    artifactBundle?: ControlDistributedRunArtifactBundle;
    state: RallarBlackBoxTestState;
    showEditor: boolean;
    copyText(text: string, message: string): Promise<void>;
    onOpenTab(tab: AppTabId): void;
}>;

export function RunnerRecipeDetail({
    selectedRecipe, launchState, localDisabledReason, localRunning,
    distributedDisabledReason, runLocalRecipe, runDistributedRecipe,
    controlRunId, globalValues, recipePreflight, launchMessage, launchError,
    lastError, runState, history, failures, latestResult, firstFailure,
    distributedRun, artifactBundle, state, showEditor, copyText, onOpenTab,
}: RunnerRecipeDetailProps) {
    return (
        <section className="runner-recipe-detail">
            <div className="section-heading">
                <h3>{selectedRecipe?.title ?? 'No recipe selected'}</h3>
                <span className={`pill ${runnerLaunchTone(launchState)}`}>
                    {launchState}
                </span>
            </div>
            {selectedRecipe ? (
                <>
                    <div className="runner-recipe-actions-primary">
                        <button
                            type="button"
                            disabled={Boolean(localDisabledReason) || localRunning}
                            title={localDisabledReason}
                            onClick={() => void runLocalRecipe()}
                        >
                            Run in this browser
                        </button>
                        <button
                            type="button"
                            disabled={
                                Boolean(distributedDisabledReason) || localRunning
                            }
                            title={distributedDisabledReason}
                            onClick={() => void runDistributedRecipe()}
                        >
                            Run on connected agents
                        </button>
                    </div>
                    {(localDisabledReason || distributedDisabledReason) && (
                        <div className="runner-disabled-reasons">
                            {localDisabledReason && (
                                <span>Local: {localDisabledReason}</span>
                            )}
                            {distributedDisabledReason && (
                                <span>
                                    Distributed:{' '}
                                    {distributedDisabledReason}
                                </span>
                            )}
                        </div>
                    )}
                    <dl className="config-list runner-recipe-meta">
                        <div>
                            <dt>Expected result</dt>
                            <dd>{selectedRecipe.expectedResult}</dd>
                        </div>
                        <div>
                            <dt>Provider</dt>
                            <dd>{selectedRecipe.providerMode}</dd>
                        </div>
                        <div>
                            <dt>Control run</dt>
                            <dd>{controlRunId || 'missing'}</dd>
                        </div>
                        <div>
                            <dt>Group</dt>
                            <dd>{globalValues.roomId || 'missing'}</dd>
                        </div>
                    </dl>
                    <div className="runner-requirements">
                        <h3>Prerequisites</h3>
                        {selectedRecipe.requirements.length === 0 ? (
                            <div className="empty-state">
                                No additional prerequisites
                            </div>
                        ) : (
                            <ul>
                                {selectedRecipe.requirements.map((requirement) => (
                                    <li key={requirement}>{requirement}</li>
                                ))}
                            </ul>
                        )}
                    </div>
                    {recipePreflight && (
                        <details className="runner-preflight" open>
                            <summary>Recipe preflight</summary>
                            <DistributedRecipePreflightPanel
                                preflight={recipePreflight}
                                compact
                            />
                        </details>
                    )}
                    <div
                        className={`runner-launch-result ${runnerLaunchTone(launchState)}`}
                        role="status"
                    >
                        <strong>{launchMessage}</strong>
                        {(launchError || lastError) && (
                            <span>
                                {launchError ??
                                    runnerFriendlyErrorMessage(lastError)}
                            </span>
                        )}
                    </div>
                    <div className="runner-result-grid">
                        <Metric
                            label="Runtime state"
                            value={runState}
                            tone={statusTone(runState)}
                        />
                        <Metric label="Commands" value={String(history.length)} />
                        <Metric
                            label="Failures"
                            value={String(failures.length)}
                            tone={failures.length > 0 ? 'bad' : 'good'}
                        />
                        <Metric
                            label="Last result"
                            value={latestResult ? resultSummary(latestResult) : '-'}
                            tone={
                                latestResult?.ok === false
                                    ? 'bad'
                                    : latestResult
                                      ? 'good'
                                      : 'muted'
                            }
                        />
                    </div>
                    {firstFailure && (
                        <div className="runner-failure-focus">
                            <strong>First failed step</strong>
                            <span>{resultSummary(firstFailure)}</span>
                            <small>
                                Likely cause: {firstFailure.error?.message ?? 'runtime evidence did not match the recipe expectation.'}
                            </small>
                            <small>
                                Next action: fix readiness, inspect Event Stream, then rerun this recipe.
                            </small>
                        </div>
                    )}
                    {distributedRun && (
                        <div className="distributed-run-summary runner-distributed-summary">
                            <Metric
                                label="Distributed run"
                                value={distributedRun.distributedRunId}
                            />
                            <Metric
                                label="State"
                                value={distributedRun.state}
                                tone={distributedRecipeStateTone(distributedRun.state)}
                            />
                            <Metric
                                label="Targets"
                                value={String(distributedRun.targetAgentIds.length)}
                            />
                            <Metric
                                label="Blocking failures"
                                value={String(
                                    distributedRun.rollup.summary.blockingFailures,
                                )}
                                tone={
                                    distributedRun.rollup.summary.blockingFailures > 0
                                        ? 'bad'
                                        : 'good'
                                }
                            />
                        </div>
                    )}
                    {artifactBundle && (
                        <div
                            className="distributed-artifact-summary runner-artifact-summary"
                            aria-label="Artifact summary"
                        >
                            <Metric
                                label="Artifact"
                                value={`schema ${artifactBundle.artifactSchemaVersion}`}
                            />
                            <Metric
                                label="Files"
                                value={String(Object.keys(artifactBundle.files).length)}
                                tone="good"
                            />
                            <Metric
                                label="Generated"
                                value={formatTime(artifactBundle.generatedAtEpochMs)}
                            />
                        </div>
                    )}
                    {!artifactBundle && history.length > 0 && (
                        <div
                            className="runner-artifact-summary"
                            aria-label="Artifact summary"
                        >
                            <Metric label="Artifact" value="local replay" tone="good" />
                            <Metric
                                label="Commands"
                                value={String(history.length)}
                            />
                            <Metric
                                label="Events"
                                value={String(state.events.length)}
                            />
                            <Metric
                                label="Replay"
                                value={latestResult?.commandId ?? '-'}
                                tone={latestResult ? 'active' : 'muted'}
                            />
                        </div>
                    )}
                    {showEditor && (
                        <div className="runner-inline-editor">
                            <div className="section-heading">
                                <h3>Recipe JSON</h3>
                                <button
                                    type="button"
                                    onClick={() =>
                                        selectedRecipe.recipe
                                            ? void copyText(
                                                  json(selectedRecipe.recipe),
                                                  'Copied recipe JSON.',
                                              )
                                            : void copyText(
                                                  selectedRecipe.copyCommand,
                                                  'Copied recipe command.',
                                              )
                                    }
                                >
                                    Copy
                                </button>
                            </div>
                            <pre className="json-block">
                                {selectedRecipe.recipe
                                    ? json(selectedRecipe.recipe)
                                    : selectedRecipe.copyCommand}
                            </pre>
                        </div>
                    )}
                    <div className="runner-secondary-actions">
                        <button type="button" onClick={() => onOpenTab('runs')}>
                            Open Runs
                        </button>
                        <button type="button" onClick={() => onOpenTab('builder')}>
                            Open Builder
                        </button>
                        <button type="button" onClick={() => onOpenTab('advanced')}>
                            Open Advanced
                        </button>
                    </div>
                </>
            ) : (
                <div className="empty-state">No recipe selected</div>
            )}
        </section>
    );
}
