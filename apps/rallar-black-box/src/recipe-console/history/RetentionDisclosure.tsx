import type { ReactNode } from 'react';
import { ExactIdentifier } from './ExactIdentifier.tsx';
import styles from './RetentionPanel.module.css';
import { RetentionWindowedList } from './RetentionWindowedList.tsx';

export type RetentionDisclosureController = Readonly<{
    openKey: string | undefined;
    toggle(key: string): void;
}>;

export function RetentionTotalIdDisclosure({
    controller,
    ids,
    label,
    revision
}: Readonly<{
    controller: RetentionDisclosureController;
    ids: readonly string[];
    label: string;
    revision: object;
}>) {
    return (
        <RetentionDisclosure
            className={styles.totalDisclosure}
            contextKey={`retention-total:${label}`}
            controller={controller}
            disclosureKey={`retention-total:${label}`}
            emptyLabel="None."
            itemKey={(id, index) => JSON.stringify([id, index])}
            itemLabel="IDs"
            items={ids}
            label={label}
            renderItem={(id) => (
                <li data-retention-total-id-row>
                    <ExactIdentifier value={id} />
                </li>
            )}
            revision={revision}
        />
    );
}

export function RetentionDisclosure<Item>({
    className,
    contextKey,
    controller,
    disclosureKey,
    emptyLabel,
    itemKey,
    itemLabel,
    items,
    label,
    renderItem,
    revision
}: Readonly<{
    className: string;
    contextKey: string;
    controller: RetentionDisclosureController;
    disclosureKey: string;
    emptyLabel: string;
    itemKey(item: Item, absoluteIndex: number): string;
    itemLabel: string;
    items: readonly Item[];
    label: string;
    renderItem(item: Item, absoluteIndex: number): ReactNode;
    revision: object;
}>) {
    const open = controller.openKey === disclosureKey;
    return (
        <details className={className} open={open}>
            <summary
                onClick={(event) => {
                    event.preventDefault();
                    controller.toggle(disclosureKey);
                }}
            >
                {label} ({items.length})
            </summary>
            {open
                ? items.length > 0
                    ? (
                        <RetentionWindowedList
                            contextKey={contextKey}
                            itemKey={itemKey}
                            itemLabel={itemLabel}
                            items={items}
                            label={label}
                            renderItem={renderItem}
                            revision={revision}
                        />
                    )
                    : <p>{emptyLabel}</p>
                : null}
        </details>
    );
}
