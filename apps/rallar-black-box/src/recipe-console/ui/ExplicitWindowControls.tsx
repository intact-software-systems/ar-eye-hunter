import type { Ref } from 'react';
import type { ExplicitWindowModel } from './explicit-window-model.ts';
import styles from './ExplicitWindowControls.module.css';

export type ExplicitWindowControlsProps = Readonly<{
    announceRange?: boolean;
    contentId: string;
    emptyLabel?: string;
    focusFallbackRef?: Ref<HTMLSpanElement>;
    itemLabel?: string;
    label: string;
    model: ExplicitWindowModel;
    pending?: boolean;
    onPrevious(): void;
    onNext(): void;
}>;

export function ExplicitWindowControls({
    announceRange = true,
    contentId,
    emptyLabel,
    focusFallbackRef,
    itemLabel = 'items',
    label,
    model,
    pending = false,
    onPrevious,
    onNext,
}: ExplicitWindowControlsProps) {
    function invoke(action: () => void): void {
        if (!pending) action();
    }

    return (
        <div
            aria-busy={pending}
            aria-label={`${label} window`}
            className={styles.controls}
            role="group"
        >
            <button
                aria-controls={contentId}
                aria-disabled={pending || undefined}
                data-explicit-window-direction="previous"
                disabled={!model.canPrevious}
                onClick={() => invoke(onPrevious)}
                type="button"
            >
                Previous
            </button>
            <span
                aria-atomic={announceRange ? 'true' : undefined}
                aria-live={announceRange ? 'polite' : undefined}
                className={styles.range}
                ref={focusFallbackRef}
                role={announceRange ? 'status' : undefined}
                tabIndex={-1}
            >
                {rangeLabel(model, itemLabel, emptyLabel)}{pending ? ' Updating…' : ''}
            </span>
            <button
                aria-controls={contentId}
                aria-disabled={pending || undefined}
                data-explicit-window-direction="next"
                disabled={!model.canNext}
                onClick={() => invoke(onNext)}
                type="button"
            >
                Next
            </button>
        </div>
    );
}

function rangeLabel(
    model: ExplicitWindowModel,
    itemLabel: string,
    emptyLabel: string | undefined,
): string {
    if (model.total === 0) return emptyLabel ?? `No ${itemLabel}.`;
    return `Showing ${number(model.displayStart)}–${number(model.displayEnd)} of ${number(model.total)} ${itemLabel}.`;
}

function number(value: number): string {
    return value.toLocaleString('en-US');
}
