import styles from './FleetWindowTruth.module.css';
import type { FleetWindowController } from './use-fleet-window.ts';

export function FleetWindowTruth({
    itemLabel,
    label,
    window
}: Readonly<{
    itemLabel: string;
    label: string;
    window: FleetWindowController;
}>) {
    const rendered = window.model.endIndexExclusive - window.model.startIndex;
    const outside = window.model.total - rendered;
    return (
        <div className={styles.truth}>
            <span
                data-fleet-window-focus-anchor={label}
                data-fleet-window-owner={window.owner}
                ref={window.focusFallbackRef}
                tabIndex={-1}
            >
                {rangeLabel(window, itemLabel)}
            </span>
            {window.model.total > window.model.windowSize
                ? (
                    <p data-fleet-window-outside>
                        {number(outside)} {itemLabel} outside this render window and browseable.
                    </p>
                )
                : null}
        </div>
    );
}

function rangeLabel(
    window: FleetWindowController,
    itemLabel: string
): string {
    if (window.model.total === 0) {
        return `No ${itemLabel}.`;
    }
    return `Showing ${number(window.model.displayStart)}–${number(window.model.displayEnd)} of ${
        number(window.model.total)
    } ${itemLabel}.`;
}

function number(value: number): string {
    return value.toLocaleString('en-US');
}
