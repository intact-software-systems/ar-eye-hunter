import type { RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/types.ts';
import { resultSummary, statusTone } from '../../shared/command-presentation.ts';
import { formatDuration } from '../../shared/time-format.ts';

export function CommandHistoryPanel({
    history,
    selectedCommandId,
    onSelect
}: {
    history: readonly RallarBlackBoxTestResult[];
    selectedCommandId?: string;
    onSelect(commandId: string): void;
}) {
    return (
        <section className="panel history-panel">
            <div className="panel-heading">
                <h2>Completed Commands</h2>
                <span>{history.length} results</span>
            </div>
            <div className="history-list">
                {history
                    .slice(-30)
                    .reverse()
                    .map((result, index) => (
                        <button
                            type="button"
                            key={`${result.commandId}-${index}`}
                            className={`history-row ${selectedCommandId === result.commandId ? 'selected' : ''}`}
                            onClick={() => onSelect(result.commandId)}
                        >
                            <span
                                className={`status-dot ${result.ok ? 'completed' : 'failed'}`}
                            />
                            <span className="history-main">
                                <strong>{result.commandId}</strong>
                                <small>{result.kind}</small>
                            </span>
                            <span>{formatDuration(result.durationMs)}</span>
                            <span
                                className={`pill ${statusTone(result.status)}`}
                            >
                                {result.status}
                            </span>
                            <small className="history-summary">
                                {resultSummary(result)}
                            </small>
                        </button>
                    ))}
            </div>
        </section>
    );
}
