import type { DistributedRunRuntimeDiagnosticRow } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type {
    RecipeConsoleDiagnosticSeverity,
    RecipeConsoleTransport,
    RecipeConsoleUrlState,
} from '../routing/url-state-contract.ts';
import type { MonitorWorkspaceModel } from './monitor-workspace-model.ts';
import type { MonitorEvidenceSelection } from './monitor-selection.ts';
import styles from './MonitorEvidence.module.css';

const DIAGNOSTIC_LIMIT = 50;

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
    const filtered = model.monitor.runtimeDiagnostics.filter(row =>
        (!severity || row.severity === severity) &&
        matchesTransport(row, transport)
    );
    const visible = filtered.slice(0, DIAGNOSTIC_LIMIT);
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
            {visible.length === 0 ? <p className={styles.empty}>No diagnostics match these filters.</p> : (
                <ul className={styles.diagnosticList}>
                    {visible.map(row => (
                        <DiagnosticRow
                            active={selected?.kind === 'diagnostic' && selected.id === row.eventId}
                            key={row.eventId}
                            onInspect={onInspect}
                            row={row}
                        />
                    ))}
                </ul>
            )}
            {filtered.length > DIAGNOSTIC_LIMIT ? <p>{filtered.length - DIAGNOSTIC_LIMIT} diagnostics omitted by view bound.</p> : null}
        </section>
    );
}

function DiagnosticRow({ row, active, onInspect }: Readonly<{
    row: DistributedRunRuntimeDiagnosticRow;
    active: boolean;
    onInspect(
        selection: MonitorEvidenceSelection,
        patch: Partial<RecipeConsoleUrlState>,
        trigger: HTMLButtonElement,
    ): void;
}>) {
    return (
        <li data-severity={row.severity}>
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
                <span>{row.summary || row.message}</span><code>{row.agentId}</code>
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
