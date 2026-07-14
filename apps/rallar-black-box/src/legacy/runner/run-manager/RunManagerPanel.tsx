import {
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import {
    controlHttpBaseUrlFromWsUrl,
    controlRunAgentRows,
    controlRunCommandRows,
    controlRunManagerStats,
    deleteControlRun,
    enqueueBulkControlCommand,
    fetchControlRunSnapshot,
    fetchControlRunArtifactBundle,
    fetchControlRunFailureBundle,
    fetchControlRunJsonl,
    fetchControlServerSnapshot,
    resetControlRun,
    type ControlRunArtifactBundle,
    type ControlRunSnapshot,
    type ControlServerSnapshot,
} from '../../../control-run-manager.ts';
import { RUN_MANAGER_COMMAND_PRESETS } from '../../../run-manager-presets.ts';
import { validateSchemaAuthoringText } from '../../../schema-authoring.ts';
import { parseRallarBlackBoxSharedTestArtifactBundle } from '../../../shared-test-handoff-fixtures.ts';
import { Metric } from '../../shared/Metric.tsx';
import { formatTime } from '../../shared/time-format.ts';
import { json } from '../../shared/json-presentation.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { SchemaAuthoringPanel } from '../../shared/schema/SchemaAuthoringPanel.tsx';
import { CommandExamplePicker } from '../../shared/schema/CommandExamplePicker.tsx';
import { RunManagerAgentRow } from './RunManagerAgentRow.tsx';
import { RunManagerCommandList } from './RunManagerCommandList.tsx';
import {
    parseRunManagerCommandText,
    runManagerCommandPrefix,
} from './run-manager-command.ts';
import { RUN_MANAGER_SNAPSHOT_BOUNDS } from '../shared/control-snapshot-bounds.ts';
import { sameStringArray } from '../../shared/same-string-array.ts';
import { artifactIssueText } from '../shared/artifact-issue-presentation.ts';
import { useLegacyDiagnosticContext } from
    '../../diagnostics/context/LegacyDiagnosticContextBar.tsx';
import { resolveRunManagerRefreshSelection } from
    '../../diagnostics/context/legacy-diagnostic-run-selection.ts';
import { useLatestRequestGuard } from
    '../shared/use-latest-request-guard.ts';

export function RunManagerPanel({
    state,
    bootstrap,
    control,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
}) {
    const diagnosticContext = useLegacyDiagnosticContext().context;
    const diagnosticControlRunId = diagnosticContext?.controlRunId;
    const [baseUrl, setBaseUrl] = useState(() =>
        controlHttpBaseUrlFromWsUrl(control.url ?? bootstrap.controlUrl),
    );
    const [token, setToken] = useState('');
    const [selectedRunId, setSelectedRunId] = useState(
        diagnosticControlRunId ?? control.runId ?? bootstrap.runId ?? '',
    );
    const [selectedAgentIds, setSelectedAgentIds] = useState<readonly string[]>(
        [],
    );
    const [commandText, setCommandText] = useState(() =>
        json(RUN_MANAGER_COMMAND_PRESETS[0].command),
    );
    const [snapshot, setSnapshot] = useState<
        ControlServerSnapshot | undefined
    >();
    const [run, setRun] = useState<ControlRunSnapshot | undefined>();
    const [artifactBundle, setArtifactBundle] = useState<
        ControlRunArtifactBundle | undefined
    >();
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [lastAction, setLastAction] = useState<string | undefined>();
    const didInitialRefresh = useRef(false);
    const lastDiagnosticControlRunId = useRef(diagnosticControlRunId);
    const selectionRequests = useLatestRequestGuard();
    const stats = useMemo(() => controlRunManagerStats(snapshot), [snapshot]);
    const agentRows = useMemo(() => controlRunAgentRows(run), [run]);
    const agentRowsKey = agentRows.map((row) => row.agentId).join('\u0000');
    const commandRows = useMemo(
        () => controlRunCommandRows(run).slice(0, 24),
        [run],
    );
    const runOptions = useMemo(
        () =>
            [...(snapshot?.runs ?? [])].sort(
                (left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs,
            ),
        [snapshot],
    );
    const selectedAgentSet = useMemo(
        () => new Set(selectedAgentIds),
        [selectedAgentIds],
    );
    const recentResults = useMemo(
        () => [...(run?.results ?? [])].reverse().slice(0, 12),
        [run],
    );
    const recentEvents = useMemo(
        () => [...(run?.events ?? [])].reverse().slice(0, 12),
        [run],
    );
    const parsedArtifact = useMemo(
        () =>
            artifactBundle
                ? parseRallarBlackBoxSharedTestArtifactBundle(
                      artifactBundle.files,
                  )
                : undefined,
        [artifactBundle],
    );
    const commandValidation = useMemo(
        () => validateSchemaAuthoringText('command', commandText),
        [commandText],
    );
    const canTargetAgents = Boolean(run && selectedAgentIds.length > 0);

    const refresh = async (preferredRunId = selectedRunId): Promise<void> => {
        const request = selectionRequests.begin();
        setBusyAction('refresh');
        setError(undefined);
        try {
            const serverSnapshot = await fetchControlServerSnapshot({
                baseUrl,
                token,
                bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
            });
            if (!request.isCurrent()) {
                return;
            }
            setSnapshot(serverSnapshot);
            const selection = resolveRunManagerRefreshSelection({
                preferredRunId,
                diagnosticControlRunId,
                controlRunId: control.runId,
                bootstrapRunId: bootstrap.runId,
                availableRunIds: serverSnapshot.runs.map(run => run.runId),
            });
            const nextRunId = selection.runId;
            setSelectedRunId(nextRunId);
            if (selection.issue) {
                setRun(undefined);
                setArtifactBundle(undefined);
                setError(selection.issue);
                setLastAction('Diagnostic run selection unavailable.');
                return;
            }
            if (nextRunId) {
                const nextRun = await fetchControlRunSnapshot({
                    baseUrl,
                    token,
                    runId: nextRunId,
                    bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
                });
                if (!request.isCurrent()) {
                    return;
                }
                setRun(nextRun);
                setArtifactBundle(undefined);
            } else {
                setRun(undefined);
                setArtifactBundle(undefined);
            }
            setLastAction(`Refreshed ${serverSnapshot.runs.length} run(s).`);
        } catch (caught) {
            if (request.isCurrent()) {
                setError(caught instanceof Error ? caught.message : String(caught));
            }
        } finally {
            if (request.isCurrent()) {
                setBusyAction(undefined);
            }
        }
    };

    useEffect(() => {
        if (didInitialRefresh.current) {
            return;
        }

        didInitialRefresh.current = true;
        void refresh();
        // The initial refresh intentionally uses the first rendered form values.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (diagnosticControlRunId === lastDiagnosticControlRunId.current) {
            return;
        }
        lastDiagnosticControlRunId.current = diagnosticControlRunId;
        const preferredRunId =
            diagnosticControlRunId ?? control.runId ?? bootstrap.runId ?? '';
        setSelectedRunId(preferredRunId);
        setRun(undefined);
        setArtifactBundle(undefined);
        void refresh(preferredRunId);
        // Context changes intentionally restart selection with current form values.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [diagnosticControlRunId]);

    useEffect(() => {
        const availableAgentIds = agentRows.map((row) => row.agentId);
        setSelectedAgentIds((previous) => {
            const kept = previous.filter((agentId) =>
                availableAgentIds.includes(agentId),
            );
            const next = kept.length > 0 ? kept : availableAgentIds;
            return sameStringArray(previous, next) ? previous : next;
        });
    }, [agentRowsKey]);

    const loadRun = async (runId: string): Promise<void> => {
        const request = selectionRequests.begin();
        setSelectedRunId(runId);
        setArtifactBundle(undefined);
        if (!runId) {
            setRun(undefined);
            setBusyAction(undefined);
            setError(undefined);
            return;
        }

        setBusyAction('load-run');
        setError(undefined);
        try {
            const loaded = await fetchControlRunSnapshot({
                baseUrl,
                token,
                runId,
                bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
            });
            if (!request.isCurrent()) {
                return;
            }
            setRun(loaded);
            setLastAction(`Loaded ${runId}.`);
        } catch (caught) {
            if (request.isCurrent()) {
                setError(caught instanceof Error ? caught.message : String(caught));
            }
        } finally {
            if (request.isCurrent()) {
                setBusyAction(undefined);
            }
        }
    };

    const enqueueSelected = async (): Promise<void> => {
        if (!run) {
            setError('Select a run before enqueueing commands.');
            return;
        }
        if (selectedAgentIds.length === 0) {
            setError('Select at least one agent.');
            return;
        }

        setBusyAction('enqueue');
        setError(undefined);
        try {
            const command = parseRunManagerCommandText(commandText);
            const result = await enqueueBulkControlCommand({
                baseUrl,
                token,
                runId: run.runId,
                agentIds: selectedAgentIds,
                command,
                commandIdPrefix: runManagerCommandPrefix(command),
            });
            setLastAction(`Queued ${result.commands.length} command(s).`);
            await refresh(run.runId);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const resetSelectedRun = async (): Promise<void> => {
        if (!run) {
            return;
        }

        setBusyAction('reset-run');
        setError(undefined);
        try {
            const resetRun = await resetControlRun({
                baseUrl,
                token,
                runId: run.runId,
            });
            setRun(resetRun);
            setLastAction(`Reset ${run.runId}.`);
            await refresh(run.runId);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const deleteSelectedRun = async (): Promise<void> => {
        if (!run) {
            return;
        }

        const deletedRunId = run.runId;
        setBusyAction('delete-run');
        setError(undefined);
        try {
            await deleteControlRun({
                baseUrl,
                token,
                runId: deletedRunId,
            });
            setRun(undefined);
            setSelectedRunId('');
            setSelectedAgentIds([]);
            setArtifactBundle(undefined);
            setLastAction(`Deleted ${deletedRunId}.`);
            await refresh('');
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const toggleAgent = (agentId: string): void => {
        setSelectedAgentIds((previous) =>
            previous.includes(agentId)
                ? previous.filter((value) => value !== agentId)
                : [...previous, agentId],
        );
    };

    const loadArtifactBundle = async (): Promise<void> => {
        if (!run) {
            return;
        }

        setBusyAction('artifact');
        setError(undefined);
        try {
            const bundle = await fetchControlRunArtifactBundle({
                baseUrl,
                token,
                runId: run.runId,
            });
            setArtifactBundle(bundle);
            setLastAction(`Loaded artifact bundle for ${run.runId}.`);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const copyArtifactBundle = async (): Promise<void> => {
        const bundle =
            artifactBundle ??
            (run
                ? await fetchControlRunArtifactBundle({
                      baseUrl,
                      token,
                      runId: run.runId,
                  })
                : undefined);
        if (bundle) {
            setArtifactBundle(bundle);
            await navigator.clipboard?.writeText(json(bundle.files));
            setLastAction('Copied artifact bundle.');
        }
    };

    const copyJsonl = async (kind: 'events' | 'results'): Promise<void> => {
        if (!run) {
            return;
        }
        const text = await fetchControlRunJsonl({
            baseUrl,
            token,
            runId: run.runId,
            kind,
        });
        await navigator.clipboard?.writeText(text);
        setLastAction(`Copied ${kind} JSONL.`);
    };

    const copyFailureBundle = async (): Promise<void> => {
        if (!run) {
            return;
        }
        const bundle = await fetchControlRunFailureBundle({
            baseUrl,
            token,
            runId: run.runId,
        });
        await navigator.clipboard?.writeText(json(bundle));
        setLastAction('Copied failure bundle.');
    };

    return (
        <section className="panel run-manager-panel">
            <div className="panel-heading">
                <h2>Run Manager</h2>
                <span>{busyAction ?? lastAction ?? 'idle'}</span>
            </div>
            <div className="run-manager-toolbar">
                <label className="field">
                    <span>Control HTTP Base URL</span>
                    <input
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                    />
                </label>
                <label className="field">
                    <span>Token</span>
                    <input
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        type="password"
                        autoComplete="off"
                    />
                </label>
                <label className="field">
                    <span>Run</span>
                    <select
                        value={selectedRunId}
                        onChange={(event) => void loadRun(event.target.value)}
                    >
                        <option value="">Select run</option>
                        {runOptions.map((option) => (
                            <option key={option.runId} value={option.runId}>
                                {option.runId}
                            </option>
                        ))}
                    </select>
                </label>
                <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={() => void refresh()}
                >
                    Refresh
                </button>
                <button
                    type="button"
                    disabled={!run || Boolean(busyAction)}
                    onClick={() => void resetSelectedRun()}
                >
                    Reset Run
                </button>
                <button
                    type="button"
                    disabled={!run || Boolean(busyAction)}
                    onClick={() => void deleteSelectedRun()}
                >
                    Delete Run
                </button>
            </div>
            <div className="run-manager-summary-grid">
                <Metric label="Runs" value={String(stats.runCount)} />
                <Metric label="Agents" value={String(stats.agentCount)} />
                <Metric
                    label="Connected"
                    value={String(stats.connectedAgentCount)}
                    tone="active"
                />
                <Metric
                    label="Queued"
                    value={String(stats.queuedCommandCount)}
                    tone="warn"
                />
                <Metric
                    label="Completed"
                    value={String(stats.completedCommandCount)}
                    tone="good"
                />
                <Metric label="Results" value={String(stats.resultCount)} />
                <Metric label="Events" value={String(stats.eventCount)} />
                <Metric label="Reports" value={String(stats.reportCount)} />
            </div>
            {error && (
                <div
                    className="workbench-error run-manager-error"
                    role="status"
                >
                    {error}
                </div>
            )}
            <div className="run-manager-layout">
                <section className="run-manager-subpanel">
                    <div className="section-heading">
                        <h3>Runs</h3>
                        <span>{runOptions.length}</span>
                    </div>
                    <div className="run-manager-run-list">
                        {runOptions.map((option) => (
                            <button
                                type="button"
                                key={option.runId}
                                className={`run-manager-run-row ${option.runId === run?.runId ? 'selected' : ''}`}
                                onClick={() => void loadRun(option.runId)}
                            >
                                <span>
                                    <strong>{option.runId}</strong>
                                    <small>
                                        {formatTime(option.updatedAtEpochMs)}
                                    </small>
                                </span>
                                <span className="pill muted">
                                    {option.agents.length} agents
                                </span>
                            </button>
                        ))}
                        {runOptions.length === 0 && (
                            <div className="empty-state">No runs</div>
                        )}
                    </div>
                </section>
                <section className="run-manager-subpanel run-manager-agents-panel">
                    <div className="section-heading">
                        <h3>Agents</h3>
                        <span>{selectedAgentIds.length} selected</span>
                    </div>
                    <div className="run-manager-agent-list">
                        {agentRows.map((row) => (
                            <RunManagerAgentRow
                                key={row.agentId}
                                row={row}
                                selected={selectedAgentSet.has(row.agentId)}
                                onToggle={toggleAgent}
                            />
                        ))}
                        {agentRows.length === 0 && (
                            <div className="empty-state">No agents</div>
                        )}
                    </div>
                    <div className="run-manager-command-editor">
                        <div className="run-manager-preset-grid">
                            {RUN_MANAGER_COMMAND_PRESETS.map((preset) => (
                                <button
                                    key={preset.presetId}
                                    type="button"
                                    onClick={() =>
                                        setCommandText(json(preset.command))
                                    }
                                >
                                    {preset.label}
                                </button>
                            ))}
                        </div>
                        <label className="field">
                            <span>Command JSON</span>
                            <textarea
                                value={commandText}
                                onChange={(event) =>
                                    setCommandText(event.target.value)
                                }
                                spellCheck={false}
                            />
                        </label>
                        <SchemaAuthoringPanel validation={commandValidation} />
                        <CommandExamplePicker
                            onInsert={setCommandText}
                            onCopy={(text) =>
                                void navigator.clipboard?.writeText(text)
                            }
                        />
                        <button
                            type="button"
                            disabled={
                                !canTargetAgents ||
                                Boolean(busyAction) ||
                                !commandValidation.ok
                            }
                            onClick={() => void enqueueSelected()}
                        >
                            Enqueue Selected
                        </button>
                    </div>
                </section>
                <section className="run-manager-subpanel run-manager-telemetry-panel">
                    <div className="section-heading">
                        <h3>Telemetry</h3>
                        <span>{run?.runId ?? 'no run'}</span>
                    </div>
                    <RunManagerCommandList rows={commandRows} />
                    <div className="run-manager-telemetry-grid">
                        <section>
                            <h3>Results</h3>
                            <div className="run-manager-mini-list">
                                {recentResults.map((result) => (
                                    <div
                                        key={`${result.agentId}-${result.commandId}`}
                                        className="run-manager-mini-row"
                                    >
                                        <strong>{result.commandId}</strong>
                                        <span
                                            className={`pill ${result.ok ? 'good' : 'bad'}`}
                                        >
                                            {result.ok ? 'ok' : 'failed'}
                                        </span>
                                        <small>{result.agentId}</small>
                                    </div>
                                ))}
                                {recentResults.length === 0 && (
                                    <div className="empty-state">
                                        No results
                                    </div>
                                )}
                            </div>
                        </section>
                        <section>
                            <h3>Recent Events</h3>
                            <div className="run-manager-mini-list">
                                {recentEvents.map((event, index) => (
                                    <div
                                        key={`${event.agentId}-${event.eventId ?? index}`}
                                        className="run-manager-mini-row"
                                    >
                                        <strong>{event.kind}</strong>
                                        <span className="pill muted">
                                            {event.agentId}
                                        </span>
                                        <small>
                                            {formatTime(event.atEpochMs)}
                                        </small>
                                        <pre className="mini-json">
                                            {redactedJson(
                                                event.payload,
                                                state,
                                                undefined,
                                                [token],
                                            )}
                                        </pre>
                                    </div>
                                ))}
                                {recentEvents.length === 0 && (
                                    <div className="empty-state">No events</div>
                                )}
                            </div>
                        </section>
                    </div>
                    <section className="run-manager-artifacts">
                        <div className="section-heading">
                            <h3>Artifacts</h3>
                            <span
                                className={`pill ${parsedArtifact?.ok ? 'good' : parsedArtifact ? 'bad' : 'muted'}`}
                            >
                                {parsedArtifact?.ok
                                    ? 'valid'
                                    : parsedArtifact
                                      ? 'invalid'
                                      : 'not loaded'}
                            </span>
                        </div>
                        <div className="run-manager-artifact-actions">
                            <button
                                type="button"
                                disabled={!run || Boolean(busyAction)}
                                onClick={() => void loadArtifactBundle()}
                            >
                                Load Artifact
                            </button>
                            <button
                                type="button"
                                disabled={!run || Boolean(busyAction)}
                                onClick={() => void copyArtifactBundle()}
                            >
                                Copy Artifact Bundle
                            </button>
                            <button
                                type="button"
                                disabled={!run || Boolean(busyAction)}
                                onClick={() => void copyJsonl('events')}
                            >
                                Copy Events JSONL
                            </button>
                            <button
                                type="button"
                                disabled={!run || Boolean(busyAction)}
                                onClick={() => void copyJsonl('results')}
                            >
                                Copy Results JSONL
                            </button>
                            <button
                                type="button"
                                disabled={!run || Boolean(busyAction)}
                                onClick={() => void copyFailureBundle()}
                            >
                                Copy Failure Bundle
                            </button>
                        </div>
                        {parsedArtifact?.value && (
                            <div className="run-manager-artifact-summary">
                                <Metric
                                    label="Total"
                                    value={String(
                                        parsedArtifact.value.report.summary
                                            .total,
                                    )}
                                />
                                <Metric
                                    label="Success"
                                    value={String(
                                        parsedArtifact.value.report.summary
                                            .success,
                                    )}
                                    tone="good"
                                />
                                <Metric
                                    label="Failure"
                                    value={String(
                                        parsedArtifact.value.report.summary
                                            .failure,
                                    )}
                                    tone={
                                        parsedArtifact.value.report.summary
                                            .failure > 0
                                            ? 'bad'
                                            : 'good'
                                    }
                                />
                                <Metric
                                    label="Events"
                                    value={String(
                                        parsedArtifact.value.views.eventStream
                                            .length,
                                    )}
                                />
                            </div>
                        )}
                        {parsedArtifact && parsedArtifact.issues.length > 0 && (
                            <div className="artifact-issue-list" role="status">
                                {parsedArtifact.issues
                                    .slice(0, 6)
                                    .map((issue, index) => (
                                        <div
                                            className={`artifact-issue-row ${issue.severity}`}
                                            key={`${issue.severity}-${issue.file ?? 'bundle'}-${issue.path}-${index}`}
                                        >
                                            <strong>{issue.severity}</strong>
                                            <span>
                                                {artifactIssueText(issue)}
                                            </span>
                                        </div>
                                    ))}
                            </div>
                        )}
                        {parsedArtifact?.value && (
                            <pre className="json-block">
                                {json(
                                    parsedArtifact.value.views.failures.length >
                                        0
                                        ? parsedArtifact.value.views.failures.slice(
                                              0,
                                              8,
                                          )
                                        : parsedArtifact.value.report.resultsList.slice(
                                              0,
                                              8,
                                          ),
                                )}
                            </pre>
                        )}
                    </section>
                </section>
            </div>
        </section>
    );
}
