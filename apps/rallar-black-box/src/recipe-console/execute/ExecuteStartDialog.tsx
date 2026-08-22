import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import styles from './ExecuteStartDialog.module.css';

export function ExecuteStartDialog({
    open,
    run,
    controlOrigin,
    busy,
    restoreFocusTo,
    fallbackFocusTo,
    onClose,
    onConfirm
}: Readonly<{
    open: boolean;
    run: ControlDistributedRunSnapshot;
    controlOrigin: string;
    busy: boolean;
    restoreFocusTo?: HTMLElement | null;
    fallbackFocusTo?: HTMLElement | null;
    onClose(): void;
    onConfirm(): void | Promise<void>;
}>) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const initialFocusRef = useRef<HTMLButtonElement>(null);
    const restoreTargetRef = useRef<HTMLElement | null | undefined>(undefined);
    const fallbackTargetRef = useRef<HTMLElement | null | undefined>(undefined);
    fallbackTargetRef.current = fallbackFocusTo;
    useEffect(() => {
        if (!open) {
            return;
        }
        restoreTargetRef.current = restoreFocusTo ?? (
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : undefined
        );
        initialFocusRef.current?.focus();
        return () => {
            const restoreTarget = restoreTargetRef.current;
            const fallbackTarget = fallbackTargetRef.current;
            const target = focusable(restoreTarget)
                ? restoreTarget
                : focusable(fallbackTarget)
                ? fallbackTarget
                : undefined;
            target?.focus();
        };
    }, [open]);
    useEffect(() => {
        if (open && busy) {
            dialogRef.current?.focus();
        }
    }, [busy, open]);

    if (!open) {
        return null;
    }
    return (
        <div className={styles.backdrop} data-execute-start-dialog>
            <div
                aria-describedby="execute-start-description"
                aria-labelledby="execute-start-heading"
                aria-modal="true"
                className={styles.dialog}
                onKeyDown={(event) => trapDialogFocus(event, dialogRef.current, busy, onClose)}
                ref={dialogRef}
                role="dialog"
                tabIndex={-1}
            >
                <header>
                    <p>Final live action</p>
                    <h2 id="execute-start-heading">Start distributed run?</h2>
                </header>
                <p id="execute-start-description">
                    Every staged target is ready. Starting releases the shared barrier and begins recipe execution.
                </p>
                <dl className={styles.facts}>
                    <Fact label="Distributed run" value={run.distributedRunId} />
                    <Fact label="Control run" value={run.controlRunId} />
                    <Fact label="Recipe" value={recipeIds(run).join(', ')} />
                    <Fact label="Group" value={groupLabel(run)} />
                    <Fact label="Control origin" value={controlOrigin} />
                    <Fact label="Targets" value={String(run.targetAgentIds.length)} />
                </dl>
                <div className={styles.actions}>
                    <button
                        disabled={busy}
                        onClick={onClose}
                        ref={initialFocusRef}
                        type="button"
                    >
                        Back
                    </button>
                    <button
                        aria-busy={busy}
                        className={styles.confirm}
                        disabled={busy}
                        onClick={() => void onConfirm()}
                        type="button"
                    >
                        {busy ? 'Starting…' : 'Start distributed run'}
                    </button>
                </div>
            </div>
        </div>
    );
}

function trapDialogFocus(
    event: KeyboardEvent<HTMLDivElement>,
    dialog: HTMLDivElement | null,
    busy: boolean,
    onClose: () => void
): void {
    if (event.key === 'Escape') {
        event.preventDefault();
        if (!busy) {
            onClose();
        }
        return;
    }
    if (event.key !== 'Tab') {
        return;
    }
    const focusableElements = Array.from(
        dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])') ?? []
    );
    if (focusableElements.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
    }
    const first = focusableElements[0];
    const last = focusableElements.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    }
    else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function recipeIds(run: ControlDistributedRunSnapshot): readonly string[] {
    return run.manifest.recipes.map((item) => item.recipeId ?? item.recipe?.recipeId ?? 'unknown recipe');
}

function groupLabel(run: ControlDistributedRunSnapshot): string {
    const group = run.manifest.group;
    return `${group.applicationId} / ${group.workspaceId} / ${group.groupId}`;
}

function Fact({ label, value }: Readonly<{ label: string; value: string; }>) {
    return (
        <div>
            <dt>{label}</dt>
            <dd>
                <code>{value}</code>
            </dd>
        </div>
    );
}

function focusable(target: HTMLElement | null | undefined): target is HTMLElement {
    return Boolean(target?.isConnected && !target.matches(':disabled'));
}
