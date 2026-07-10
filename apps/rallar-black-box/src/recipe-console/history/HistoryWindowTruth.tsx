import type { HistoryWindowController } from './use-history-window.ts';
import styles from './HistoryTable.module.css';

export function HistoryWindowTruth({
    window,
}: Readonly<{ window: HistoryWindowController }>) {
    const rendered = window.model.endIndexExclusive - window.model.startIndex;
    const outside = window.model.total - rendered;
    return (
        <>
            <span
                className={styles.focusAnchor}
                data-history-window-focus-anchor
                ref={window.focusFallbackRef}
                tabIndex={-1}
            >{rangeLabel(window)}</span>
            {window.model.total > window.model.windowSize ? (
                <p className={styles.outside} data-history-window-outside>
                    {number(outside)} runs outside this render window and browseable.
                </p>
            ) : null}
        </>
    );
}

function rangeLabel(window: HistoryWindowController): string {
    if (window.model.total === 0) return 'No runs.';
    return `Showing ${number(window.model.displayStart)}–${
        number(window.model.displayEnd)
    } of ${number(window.model.total)} runs.`;
}

function number(value: number): string {
    return value.toLocaleString('en-US');
}
