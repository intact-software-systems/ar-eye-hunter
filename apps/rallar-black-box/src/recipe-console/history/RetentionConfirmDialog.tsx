import {
    useEffect,
    useRef,
    type KeyboardEvent,
    type MouseEvent,
} from 'react';
import type { RetentionCleanupPreview } from './use-retention-cleanup.ts';
import { ExactIdentifier } from './ExactIdentifier.tsx';
import { RetentionWindowedList } from './RetentionWindowedList.tsx';
import styles from './RetentionConfirmDialog.module.css';

export type RetentionConfirmDialogProps = Readonly<{
    open: boolean;
    preview: RetentionCleanupPreview | undefined;
    busy: boolean;
    message?: string;
    restoreFocus: HTMLButtonElement | null;
    onCancel(): void;
    onConfirm(): void;
}>;

export function RetentionConfirmDialog({
    open,
    preview,
    busy,
    message,
    restoreFocus,
    onCancel,
    onConfirm,
}: RetentionConfirmDialogProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const keepRef = useRef<HTMLButtonElement>(null);
    const submittedRef = useRef(false);

    useEffect(() => {
        if (!open || !preview) return;
        keepRef.current?.focus();
        return () => {
            if (focusableRestoreTarget(restoreFocus)) restoreFocus.focus();
        };
    }, [open, preview, restoreFocus]);
    useEffect(() => {
        if (open && busy) dialogRef.current?.focus();
        if (!busy) submittedRef.current = false;
    }, [busy, open, preview]);

    if (!open || !preview) return null;
    const confirmable = preview.current && !busy;

    function cancel(): void {
        if (!busy) onCancel();
    }

    function confirm(): void {
        if (!confirmable || submittedRef.current) return;
        submittedRef.current = true;
        onConfirm();
    }

    function onBackdropClick(event: MouseEvent<HTMLDivElement>): void {
        if (event.target === event.currentTarget) cancel();
    }

    function trapFocus(event: KeyboardEvent<HTMLDivElement>): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
                '[tabindex="0"], button:not(:disabled)',
            ) ?? [],
        );
        if (focusable.length === 0) {
            event.preventDefault();
            dialogRef.current?.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
        } else if (!focusable.includes(document.activeElement as HTMLElement)) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
        }
    }

    return (
        <div
            className={styles.backdrop}
            data-retention-confirm-dialog
            onClick={onBackdropClick}
        >
            <div
                aria-describedby="retention-confirm-description"
                aria-labelledby="retention-confirm-heading"
                aria-modal="true"
                className={styles.dialog}
                onKeyDown={trapFocus}
                ref={dialogRef}
                role="alertdialog"
                tabIndex={-1}
            >
                <header>
                    <p className={styles.eyebrow}>Destructive local cleanup</p>
                    <h2 id="retention-confirm-heading">Delete previewed runs?</h2>
                </header>
                <p id="retention-confirm-description">
                    This deletes {preview.candidates.length} control
                    {preview.candidates.length === 1 ? ' run' : ' runs'} from
                    in-memory control, distributed, and fleet history. It moves
                    from {preview.retainedRuns} current runs to{' '}
                    {preview.projectedRetainedRuns} projected runs.
                </p>
                <RetentionWindowedList
                    className={styles.candidates}
                    contextKey="retention-confirm-candidates"
                    itemKey={candidate => candidate.key}
                    itemLabel="candidates"
                    items={preview.candidates}
                    label="Previewed runs to delete"
                    renderItem={candidate => (
                        <li data-retention-dialog-candidate-row>
                            <ExactIdentifier value={candidate.runId} />
                        </li>
                    )}
                    revision={preview}
                    scrollRegion={{
                        ariaLabel: 'Previewed runs to delete',
                        className: styles.candidateScroller,
                    }}
                />
                <p className={styles.preservation}>
                    Existing connected sockets and stored artifact files remain.
                </p>
                {!preview.current ? (
                    <p className={styles.stale}>This preview is stale. Preview again.</p>
                ) : null}
                {message ? (
                    <p aria-live="assertive" className={styles.message}>{message}</p>
                ) : null}
                <div className={styles.actions}>
                    <button
                        disabled={busy}
                        onClick={cancel}
                        ref={keepRef}
                        type="button"
                    >Keep history</button>
                    <button
                        aria-busy={busy}
                        className={styles.confirm}
                        disabled={!confirmable}
                        onClick={confirm}
                        type="button"
                    >Delete previewed runs</button>
                </div>
            </div>
        </div>
    );
}

function focusableRestoreTarget(
    target: HTMLButtonElement | null,
): target is HTMLButtonElement {
    return Boolean(target?.isConnected && !target.disabled);
}
