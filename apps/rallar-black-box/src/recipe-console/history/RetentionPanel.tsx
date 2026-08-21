import { useEffect, useRef, useState } from 'react';
import { RetentionCleanupResult, RetentionPreviewEvidence } from './RetentionConsequenceViews.tsx';
import styles from './RetentionPanel.module.css';
import type { RetentionCleanupController } from './use-retention-cleanup.ts';

export type RetentionPanelProps = Readonly<{
    controller: RetentionCleanupController;
    onRequestConfirm(returnFocus: HTMLButtonElement): void;
    reviewing?: boolean;
}>;

export function RetentionPanel({
    controller,
    onRequestConfirm,
    reviewing = false
}: RetentionPanelProps) {
    const previewButtonRef = useRef<HTMLButtonElement>(null);
    const [openDisclosure, setOpenDisclosure] = useState<string>();
    const preview = controller.state.preview;
    const reviewable = preview?.current === true &&
        preview.maxRuns > 0 &&
        preview.candidates.length > 0 &&
        controller.canConfirm;
    const disclosureController = {
        openKey: openDisclosure,
        toggle(key: string): void {
            setOpenDisclosure((current) => current === key ? undefined : key);
        }
    } as const;
    useEffect(() => {
        setOpenDisclosure(undefined);
    }, [controller.state.confirmation, preview, reviewing]);

    return (
        <section
            aria-labelledby="retention-panel-heading"
            className={styles.panel}
            data-retention-panel
        >
            <header className={styles.heading}>
                <div>
                    <p className={styles.eyebrow}>Signal ledger</p>
                    <h3 id="retention-panel-heading">Local history retention</h3>
                </div>
                <div className={styles.actions}>
                    <button
                        aria-busy={controller.busy}
                        disabled={!controller.canPreview || controller.busy}
                        onClick={() => {
                            setOpenDisclosure(undefined);
                            void controller.preview();
                        }}
                        ref={previewButtonRef}
                        type="button"
                    >
                        Preview cleanup
                    </button>
                    {reviewable
                        ? (
                            <button
                                className={styles.review}
                                onClick={() => {
                                    setOpenDisclosure(undefined);
                                    onRequestConfirm(previewButtonRef.current!);
                                }}
                                type="button"
                            >
                                Review cleanup
                            </button>
                        )
                        : null}
                </div>
            </header>

            <p
                aria-atomic="true"
                aria-live="polite"
                className={styles.status}
                role="status"
            >
                {controller.state.message ?? statusMessage(
                    controller.state.status
                )}
            </p>

            {preview
                ? (
                    <RetentionPreviewEvidence
                        controller={disclosureController}
                        preview={preview}
                        suppressPressure={reviewing}
                    />
                )
                : null}
            {controller.state.confirmation
                ? (
                    <RetentionCleanupResult
                        confirmation={controller.state.confirmation}
                        controller={disclosureController}
                    />
                )
                : null}
        </section>
    );
}

function statusMessage(
    status: RetentionCleanupController['state']['status']
): string {
    switch (status) {
        case 'idle':
            return 'Preview retention consequences before cleanup.';
        case 'previewing':
            return 'Building retention preview…';
        case 'preview-ready':
            return 'Retention preview is current.';
        case 'confirming':
            return 'Deleting previewed in-memory history…';
        case 'succeeded':
            return 'Retention cleanup succeeded.';
        case 'drift':
            return 'Retention preview is stale; preview cleanup again.';
        case 'error':
            return 'Retention cleanup failed.';
        case 'unavailable':
            return 'Retention cleanup is unavailable.';
    }
}
