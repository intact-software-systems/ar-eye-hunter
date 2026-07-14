import { ExplicitWindowControls } from
    '../ui/ExplicitWindowControls.tsx';
import { FleetWindowTruth } from './FleetWindowTruth.tsx';
import type { FleetWindowController } from './use-fleet-window.ts';
import styles from './FleetWindowControls.module.css';

export function FleetWindowControls({
    contentId,
    itemLabel,
    label,
    window,
}: Readonly<{
    contentId: string;
    itemLabel: string;
    label: string;
    window: FleetWindowController;
}>) {
    const focusProps = window.controlsFocusProps;
    return (
        <div
            className={styles.root}
            {...focusProps}
            onClick={(event) => {
                focusProps.onClick(event);
                const direction = event.target instanceof Element
                    ? event.target.closest(
                        'button[data-explicit-window-direction]',
                    )
                    : null;
                if (direction && event.currentTarget.contains(direction)) {
                    event.stopPropagation();
                }
            }}
        >
            {window.model.total > window.model.windowSize ? (
                <ExplicitWindowControls
                    announceRange={false}
                    contentId={contentId}
                    itemLabel={itemLabel}
                    label={label}
                    model={window.model}
                    onNext={window.next}
                    onPrevious={window.previous}
                />
            ) : null}
            <FleetWindowTruth
                itemLabel={itemLabel}
                label={label}
                window={window}
            />
        </div>
    );
}
