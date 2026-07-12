import type { KeyboardEvent } from 'react';
import { useEffect, useRef } from 'react';
import type {
    ControlDistributedRunSnapshot,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import styles from './ExecuteCancelDialog.module.css';

export type ExecuteCancelDialogProps = Readonly<{
    open: boolean;
    run: ControlDistributedRunSnapshot;
    busy: boolean;
    restoreFocusTo?: HTMLElement | null;
    fallbackFocusTo?: HTMLElement | null;
    onClose(): void;
    onConfirm(): void | Promise<void>;
}>;

export function ExecuteCancelDialog({
    open,
    run,
    busy,
    restoreFocusTo,
    fallbackFocusTo,
    onClose,
    onConfirm,
}: ExecuteCancelDialogProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const initialFocusRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) return;
        const restoreTarget = restoreFocusTo ?? (
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : undefined
        );
        initialFocusRef.current?.focus();
        return () => {
            const target = focusableRestoreTarget(restoreTarget)
                ? restoreTarget
                : focusableRestoreTarget(fallbackFocusTo)
                ? fallbackFocusTo
                : undefined;
            target?.focus();
        };
    }, [fallbackFocusTo, open, restoreFocusTo]);
    useEffect(() => {
        if (open && busy) dialogRef.current?.focus();
    }, [busy, open]);

    if (!open) return null;

    function trapFocus(event: KeyboardEvent<HTMLDivElement>): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            if (!busy) onClose();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
            ) ?? [],
        );
        if (focusable.length === 0) {
            event.preventDefault();
            dialogRef.current?.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const activeIndex = focusable.indexOf(
            document.activeElement as HTMLElement,
        );
        if (activeIndex === -1) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
        }
    }

    return (
        <div className={styles.backdrop} data-execute-cancel-dialog>
            <div
                aria-describedby="execute-cancel-description"
                aria-labelledby="execute-cancel-heading"
                aria-modal="true"
                className={styles.dialog}
                onKeyDown={trapFocus}
                ref={dialogRef}
                role="alertdialog"
                tabIndex={-1}
            >
                <header>
                    <p className={styles.eyebrow}>Destructive live action</p>
                    <h2 id="execute-cancel-heading">Cancel distributed run?</h2>
                </header>
                <p id="execute-cancel-description">
                    Cancellation is sent to the control server and every active target. Completed evidence remains available for export and analysis.
                </p>
                <dl className={styles.facts}>
                    <Fact label="Distributed run" value={run.distributedRunId} />
                    <Fact label="Control run" value={run.controlRunId} />
                    <Fact label="State" value={run.state} />
                    <Fact label="Targets" value={String(run.targetAgentIds.length)} />
                </dl>
                <div className={styles.actions}>
                    <button
                        disabled={busy}
                        onClick={onClose}
                        ref={initialFocusRef}
                        type="button"
                    >Keep run</button>
                    <button
                        aria-busy={busy}
                        className={styles.confirm}
                        disabled={busy}
                        onClick={() => void onConfirm()}
                        type="button"
                    >{busy ? 'Cancelling…' : 'Cancel run'}</button>
                </div>
            </div>
        </div>
    );
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>) {
    return <div><dt>{label}</dt><dd><code>{value}</code></dd></div>;
}

function focusableRestoreTarget(
    target: HTMLElement | null | undefined,
): target is HTMLElement {
    return Boolean(target?.isConnected && !target.matches(':disabled'));
}
