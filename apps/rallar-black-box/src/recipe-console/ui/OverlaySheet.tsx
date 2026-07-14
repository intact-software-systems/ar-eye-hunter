import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { IconButton } from './IconButton.tsx';
import styles from './primitives.module.css';

export type OverlaySheetProps = Readonly<{
    mode: 'rail' | 'overlay' | 'sheet';
    open: boolean;
    label: string;
    onClose(): void;
    restoreFocusTo?: HTMLElement | null;
    restoreFocusFallback?(): HTMLElement | null;
    children: ReactNode;
}>;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function OverlaySheet({
    mode,
    open,
    label,
    onClose,
    restoreFocusTo,
    restoreFocusFallback,
    children,
}: OverlaySheetProps) {
    const hostRef = useRef<HTMLElement>(null);
    const modal = mode !== 'rail';

    useEffect(() => {
        if (!open || !modal) return;
        const frame = requestAnimationFrame(() => {
            hostRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
        });
        return () => cancelAnimationFrame(frame);
    }, [modal, open]);

    if (!open) return null;

    function closeAndRestore(): void {
        onClose();
        queueMicrotask(() => {
            const target = availableFocusTarget(restoreFocusTo)
                ? restoreFocusTo
                : restoreFocusFallback?.();
            if (availableFocusTarget(target)) target.focus();
        });
    }

    function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
        if (!modal) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeAndRestore();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(
            hostRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
        )
            .filter(element => element.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    return (
        <aside
            aria-label={label}
            aria-modal={modal ? true : undefined}
            className={styles.overlaySheet}
            data-inspector-host
            data-mode={mode}
            onKeyDown={handleKeyDown}
            ref={hostRef}
            role={modal ? 'dialog' : 'complementary'}
        >
            <header className={styles.overlayHeader}>
                <strong>{label}</strong>
                {modal ? (
                    <IconButton aria-label="Close inspector" icon="close" onClick={closeAndRestore} />
                ) : null}
            </header>
            <div className={styles.overlayContent}>{children}</div>
        </aside>
    );
}

function availableFocusTarget(
    target: HTMLElement | null | undefined,
): target is HTMLElement {
    return Boolean(target?.isConnected && !target.matches(':disabled'));
}
