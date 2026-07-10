import { Fragment, useId, type ReactNode } from 'react';
import { ExplicitWindowControls } from '../ui/ExplicitWindowControls.tsx';
import {
    useExplicitWindow,
    useExplicitWindowFocusRecovery,
} from '../ui/use-explicit-window.ts';
import styles from './RetentionWindowedList.module.css';

export const RECIPE_CONSOLE_RETENTION_SURFACE_ROW_BUDGET = 100;
export const RECIPE_CONSOLE_RETENTION_WINDOW_SIZE =
    RECIPE_CONSOLE_RETENTION_SURFACE_ROW_BUDGET / 2;

export function RetentionWindowedList<Item>({
    className,
    contextKey,
    itemKey,
    itemLabel,
    items,
    label,
    ordered = false,
    renderItem,
    revision,
    scrollRegion,
}: Readonly<{
    className?: string;
    contextKey: string;
    itemKey(item: Item, absoluteIndex: number): string;
    itemLabel: string;
    items: readonly Item[];
    label: string;
    ordered?: boolean;
    renderItem(item: Item, absoluteIndex: number): ReactNode;
    revision?: object;
    scrollRegion?: Readonly<{ ariaLabel: string; className: string }>;
}>) {
    const generatedId = useId();
    const contentId = `retention-window-${generatedId}`;
    const controller = useExplicitWindow({
        fingerprint: JSON.stringify([
            'retention-window-v1',
            contextKey,
            label,
        ]),
        revision,
        total: items.length,
        windowSize: RECIPE_CONSOLE_RETENTION_WINDOW_SIZE,
    });
    const focus = useExplicitWindowFocusRecovery(controller.model);
    const visible = items.slice(
        controller.model.startIndex,
        controller.model.endIndexExclusive,
    );
    const List = ordered ? 'ol' : 'ul';
    const list = (
        <List
            className={className}
            id={contentId}
            start={ordered ? controller.model.displayStart : undefined}
            {...(scrollRegion ? {} : focus.contentFocusProps)}
        >
            {visible.map((item, offset) => {
                const absoluteIndex = controller.model.startIndex + offset;
                return <Fragment key={itemKey(item, absoluteIndex)}>
                    {renderItem(item, absoluteIndex)}
                </Fragment>;
            })}
        </List>
    );
    return <>
        {controller.model.total > controller.model.windowSize ? (
            <div className={styles.controls} {...focus.contentFocusProps}>
                <ExplicitWindowControls
                    contentId={contentId}
                    itemLabel={itemLabel}
                    label={label}
                    model={controller.model}
                    onNext={controller.next}
                    onPrevious={controller.previous}
                />
            </div>
        ) : null}
        <span
            className={styles.focusAnchor}
            data-retention-window-focus-anchor={label}
            ref={focus.fallbackFocusRef}
            tabIndex={-1}
        >{rangeLabel(controller.model, itemLabel)}</span>
        {controller.model.total > controller.model.windowSize ? (
            <p className={styles.truth} data-retention-window-truth={label}>
                {outsideCount(controller.model).toLocaleString('en-US')}{' '}
                {itemLabel} outside this window and browseable.
            </p>
        ) : null}
        {scrollRegion ? (
            <div
                aria-label={scrollRegion.ariaLabel}
                className={scrollRegion.className}
                role="region"
                tabIndex={0}
                {...focus.contentFocusProps}
            >{list}</div>
        ) : list}
    </>;
}

function rangeLabel(
    model: Readonly<{ total: number; displayStart: number; displayEnd: number }>,
    itemLabel: string,
): string {
    return model.total === 0
        ? `No ${itemLabel}.`
        : `Showing ${model.displayStart.toLocaleString('en-US')}–${
            model.displayEnd.toLocaleString('en-US')
        } of ${model.total.toLocaleString('en-US')} ${itemLabel}.`;
}

function outsideCount(model: Readonly<{
    total: number;
    startIndex: number;
    endIndexExclusive: number;
}>): number {
    return model.total - (model.endIndexExclusive - model.startIndex);
}
