import { Fragment, type ReactNode } from 'react';
import { ExplicitWindowControls } from '../ui/ExplicitWindowControls.tsx';
import type { ExecuteWindowSection } from './execute-window-contract.ts';
import { useExecuteWindow } from './use-execute-window.ts';
import styles from './ExecuteWindowedList.module.css';

export function ExecuteWindowedList<Item>({
    className,
    contentId,
    contextKey,
    itemKey,
    itemLabel,
    items,
    label,
    ordered = false,
    renderItem,
    revisionKey,
    section,
}: Readonly<{
    className?: string;
    contentId: string;
    contextKey: string;
    itemKey(item: Item, absoluteIndex: number): string;
    itemLabel: string;
    items: readonly Item[];
    label: string;
    ordered?: boolean;
    renderItem(item: Item, absoluteIndex: number): ReactNode;
    revisionKey: string;
    section: ExecuteWindowSection;
}>) {
    const window = useExecuteWindow({
        contextKey,
        revisionKey,
        section,
        total: items.length,
    });
    const visible = items.slice(
        window.model.startIndex,
        window.model.endIndexExclusive,
    );
    const List = ordered ? 'ol' : 'ul';
    return <>
        {window.model.total > window.model.windowSize ? (
            <div data-execute-window-controls={section} {...window.controlsFocusProps}>
                <ExplicitWindowControls
                    contentId={contentId}
                    itemLabel={itemLabel}
                    label={label}
                    model={window.model}
                    onNext={window.next}
                    onPrevious={window.previous}
                />
            </div>
        ) : null}
        {window.model.total > window.model.windowSize ? (
            <p className={styles.truth} data-execute-window-truth={section}>
                {outsideCount(window.model).toLocaleString('en-US')} {itemLabel}{' '}
                outside this window and browseable.
            </p>
        ) : null}
        <span
            className={styles.focusAnchor}
            data-execute-window-focus-anchor={section}
            ref={window.focusFallbackRef}
            tabIndex={-1}
        >{window.model.total === 0
            ? `No ${itemLabel}.`
            : `Showing ${window.model.displayStart.toLocaleString('en-US')}–${
                window.model.displayEnd.toLocaleString('en-US')
            } of ${window.model.total.toLocaleString('en-US')} ${itemLabel}.`}</span>
        <List
            className={className}
            data-execute-window={section}
            id={contentId}
            start={ordered ? window.model.displayStart : undefined}
            {...window.contentFocusProps}
        >
            {visible.map((item, offset) => {
                const absoluteIndex = window.model.startIndex + offset;
                return <Fragment key={itemKey(item, absoluteIndex)}>
                    {renderItem(item, absoluteIndex)}
                </Fragment>;
            })}
        </List>
    </>;
}

function outsideCount(model: Readonly<{
    total: number;
    startIndex: number;
    endIndexExclusive: number;
}>): number {
    return model.total - (model.endIndexExclusive - model.startIndex);
}
