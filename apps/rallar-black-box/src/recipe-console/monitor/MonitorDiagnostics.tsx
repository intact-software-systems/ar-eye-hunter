import type { DistributedRunRuntimeDiagnosticRow } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type {
    RecipeConsoleDiagnosticSeverity,
    RecipeConsoleTransport,
    RecipeConsoleUrlState,
} from '../routing/url-state-contract.ts';
import type { MonitorWorkspaceModel } from './monitor-workspace-model.ts';
import type { MonitorEvidenceSelection } from './monitor-selection.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import { ExplicitWindowControls } from '../ui/ExplicitWindowControls.tsx';
import { MonitorWindowTruth } from './MonitorWindowTruth.tsx';
import { useMonitorWindow } from './use-monitor-window.ts';
import styles from './MonitorEvidence.module.css';

const CONTENT_ID = 'monitor-diagnostics-window';

export function MonitorDiagnostics({
    model,
    severity,
    transport,
    selected,
    onFilter,
    onInspect,
}: Readonly<{
    model: MonitorWorkspaceModel;
    severity?: RecipeConsoleDiagnosticSeverity;
    transport?: RecipeConsoleTransport;
    selected?: MonitorEvidenceSelection;
    onFilter(patch: Partial<RecipeConsoleUrlState>): void;
    onInspect(
        selection: MonitorEvidenceSelection,
        patch: Partial<RecipeConsoleUrlState>,
        trigger: HTMLButtonElement,
    ): void;
}>) {
    const filtered: Array<Readonly<{
        row: DistributedRunRuntimeDiagnosticRow;
        sourceOrdinal: number;
    }>> = [];
    model.monitor.runtimeDiagnostics.forEach((row, sourceOrdinal) => {
        if (
            (!severity || row.severity === severity) &&
            matchesTransport(row, transport)
        ) filtered.push({ row, sourceOrdinal });
    });
    const window = useMonitorWindow({
        contextKey: model.source.contextKey,
        section: 'diagnostics',
        total: filtered.length,
        diagnosticSeverity: severity,
        transport,
    });
    const visible = filtered.slice(
        window.model.startIndex,
        window.model.endIndexExclusive,
    );
    const counts = model.monitor.diagnosticCounts;
    return (
        <section className={styles.diagnostics} data-monitor-diagnostics>
            <header>
                <div><p className={styles.eyebrow}>Runtime signals</p><h2>Diagnostics ({counts.total})</h2></div>
                <div className={styles.counts} aria-label="Diagnostic counts">
                    <span>{counts.error} error</span><span>{counts.warning} warning</span>
                    <span>{counts.rtc} RTC</span><span>{counts.ws} WS</span>
                </div>
            </header>
            <div className={styles.filters}>
                <label><span>Severity</span><select value={severity ?? ''} onChange={event => onFilter({ diagnosticSeverity: valueOrUndefined(event.target.value) as RecipeConsoleDiagnosticSeverity | undefined })}>
                    <option value="">All severities</option><option value="debug">Debug</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option>
                </select></label>
                <label><span>Transport</span><select value={transport ?? ''} onChange={event => onFilter({ transport: valueOrUndefined(event.target.value) as RecipeConsoleTransport | undefined })}>
                    <option value="">All transports</option><option value="realtime">Realtime</option><option value="messages.rtc">Messages RTC</option><option value="ws">WS</option><option value="http">HTTP</option><option value="runtime">Runtime</option>
                </select></label>
            </div>
            {window.model.total > window.model.windowSize ? (
                <div data-monitor-window-controls {...window.controlsFocusProps}>
                    <ExplicitWindowControls
                        contentId={CONTENT_ID}
                        itemLabel="diagnostics"
                        label="Diagnostics"
                        model={window.model}
                        onNext={window.next}
                        onPrevious={window.previous}
                    />
                </div>
            ) : null}
            <MonitorWindowTruth
                itemLabel="diagnostics"
                label="Diagnostics"
                window={window}
            />
            {visible.length === 0 ? <p className={styles.empty}>No diagnostics match these filters.</p> : (
                <ul
                    className={styles.diagnosticList}
                    id={CONTENT_ID}
                    {...window.contentFocusProps}
                >
                    {visible.map(({ row, sourceOrdinal }) => (
                        <DiagnosticRow
                            active={selected?.kind === 'diagnostic' && selected.id === row.eventId}
                            key={sourceOrdinal}
                            onInspect={onInspect}
                            row={row}
                            sourceOrdinal={sourceOrdinal}
                        />
                    ))}
                </ul>
            )}
        </section>
    );
}

function DiagnosticRow({ row, active, onInspect, sourceOrdinal }: Readonly<{
    row: DistributedRunRuntimeDiagnosticRow;
    active: boolean;
    sourceOrdinal: number;
    onInspect(
        selection: MonitorEvidenceSelection,
        patch: Partial<RecipeConsoleUrlState>,
        trigger: HTMLButtonElement,
    ): void;
}>) {
    return (
        <li
            data-monitor-diagnostic-row
            data-monitor-source-ordinal={sourceOrdinal}
            data-severity={row.severity}
        >
            <button
                aria-pressed={active}
                onClick={event => onInspect(
                    { kind: 'diagnostic', id: row.eventId },
                    {
                        agentId: row.agentId,
                        recipeId: undefined,
                        commandId: row.commandId,
                    },
                    event.currentTarget,
                )}
                type="button"
            >
                <span><strong>{row.diagnosticTypeId}</strong><small>{row.transport ?? 'runtime'} · {row.severity}</small></span>
                <span>{row.summary || row.message}</span><ExactIdentifier value={row.agentId} />
            </button>
        </li>
    );
}

function valueOrUndefined(value: string): string | undefined {
    return value || undefined;
}

function matchesTransport(
    row: DistributedRunRuntimeDiagnosticRow,
    transport: RecipeConsoleTransport | undefined,
): boolean {
    if (!transport) return true;
    return transport === 'runtime'
        ? row.transport === undefined
        : row.transport === transport;
}
