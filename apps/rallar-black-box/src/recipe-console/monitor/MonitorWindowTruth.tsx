import type { MonitorWindowController } from './use-monitor-window.ts';
import styles from './MonitorWindowTruth.module.css';

export function MonitorWindowTruth({
    itemLabel,
    label,
    window,
}: Readonly<{
    itemLabel: string;
    label: string;
    window: MonitorWindowController;
}>) {
    const rendered = window.model.endIndexExclusive - window.model.startIndex;
    const outside = window.model.total - rendered;
    return (
        <>
            <span
                className={styles.focusAnchor}
                data-monitor-window-focus-anchor={label}
                data-monitor-window-owner={window.owner}
                ref={window.focusFallbackRef}
                tabIndex={-1}
            >{rangeLabel(window, itemLabel)}</span>
            {window.model.total > window.model.windowSize ? (
                <p data-monitor-window-outside>
                    {number(outside)} {itemLabel} outside this render window and browseable.
                </p>
            ) : null}
        </>
    );
}

function rangeLabel(
    window: MonitorWindowController,
    itemLabel: string,
): string {
    if (window.model.total === 0) return `No ${itemLabel}.`;
    return `Showing ${number(window.model.displayStart)}–${
        number(window.model.displayEnd)
    } of ${number(window.model.total)} ${itemLabel}.`;
}

function number(value: number): string {
    return value.toLocaleString('en-US');
}
