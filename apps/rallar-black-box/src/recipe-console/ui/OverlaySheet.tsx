import type { ReactNode } from 'react';
import { IconButton } from './IconButton.tsx';
import styles from './primitives.module.css';

export type OverlaySheetProps = Readonly<{
    mode: 'rail' | 'overlay' | 'sheet';
    open: boolean;
    label: string;
    onClose(): void;
    children: ReactNode;
}>;

export function OverlaySheet({ mode, open, label, onClose, children }: OverlaySheetProps) {
    if (!open) return null;
    const modal = mode !== 'rail';
    return (
        <aside
            aria-label={label}
            aria-modal={modal ? true : undefined}
            className={styles.overlaySheet}
            data-inspector-host
            data-mode={mode}
            role={modal ? 'dialog' : 'complementary'}
        >
            <header className={styles.overlayHeader}>
                <strong>{label}</strong>
                {modal ? (
                    <IconButton aria-label="Close inspector" icon="close" onClick={onClose} />
                ) : null}
            </header>
            <div className={styles.overlayContent}>{children}</div>
        </aside>
    );
}
