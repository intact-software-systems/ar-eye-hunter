import { useEffect, useRef, useState } from 'react';
import type { RecipeConsoleControlRetentionCapability } from
    '../control/control-api.ts';
import type {
    ControlQueryAuthorization,
    ControlQueryError,
} from '../control/control-query.ts';
import type { RecipeConsoleUrlState } from
    '../routing/url-state-contract.ts';
import { RetentionConfirmDialog } from './RetentionConfirmDialog.tsx';
import { RetentionPanel } from './RetentionPanel.tsx';
import {
    captureRetentionSelectionBeforeCleanup,
    retentionSelectionPatchAfterCleanup,
} from './retention-selection-patch.ts';
import { useRetentionCleanup } from './use-retention-cleanup.ts';

export function HistoryRetentionWorkspace({
    authorization,
    capability,
    lastError,
    refreshAfterCurrent,
    replace,
    urlState,
}: Readonly<{
    authorization: ControlQueryAuthorization;
    capability?: RecipeConsoleControlRetentionCapability;
    lastError?: ControlQueryError;
    refreshAfterCurrent(): Promise<void>;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
    urlState: RecipeConsoleUrlState;
}>) {
    const availability = retentionAvailability(
        capability,
        authorization,
        lastError,
    );
    const cleanup = useRetentionCleanup(availability);
    const [dialogOpen, setDialogOpen] = useState(false);
    const restoreFocusRef = useRef<HTMLButtonElement | null>(null);
    const latestUrlStateRef = useRef(urlState);
    latestUrlStateRef.current = urlState;

    useEffect(() => {
        if (
            dialogOpen &&
            ['drift', 'error', 'unavailable', 'succeeded'].includes(
                cleanup.state.status,
            )
        ) {
            setDialogOpen(false);
        }
    }, [cleanup.state.status, dialogOpen]);

    function requestConfirm(returnFocus: HTMLButtonElement): void {
        if (!cleanup.canConfirm) return;
        restoreFocusRef.current = returnFocus;
        setDialogOpen(true);
    }

    function confirm(): void {
        const preview = cleanup.state.preview;
        if (!preview?.current || !cleanup.canConfirm) return;
        const capture = captureRetentionSelectionBeforeCleanup({
            urlState,
            candidates: preview.candidates,
        });
        void cleanup.confirm(async (confirmation, _preview, signal) => {
            await refreshAfterCurrent();
            if (signal.aborted) return;
            const patch = retentionSelectionPatchAfterCleanup({
                capture,
                currentUrlState: latestUrlStateRef.current,
                deletedRunIds: confirmation.deletedRunIds,
            });
            if (Object.keys(patch).length > 0) replace(patch);
        });
    }

    return (
        <>
            <RetentionPanel
                controller={cleanup}
                onRequestConfirm={requestConfirm}
            />
            <RetentionConfirmDialog
                busy={cleanup.busy}
                message={cleanup.busy
                    ? 'Deleting previewed runs…'
                    : cleanup.state.message}
                onCancel={() => setDialogOpen(false)}
                onConfirm={confirm}
                open={dialogOpen}
                preview={cleanup.state.preview}
                restoreFocus={restoreFocusRef.current}
            />
        </>
    );
}

function retentionAvailability(
    capability: RecipeConsoleControlRetentionCapability | undefined,
    authorization: ControlQueryAuthorization,
    lastError: ControlQueryError | undefined,
): Readonly<{
    capability?: RecipeConsoleControlRetentionCapability;
    unavailableReason?: string;
}> {
    if (lastError?.credentialTrustRequired === true) {
        return { unavailableReason: lastError.message };
    }
    if (authorization === 'required') {
        return { unavailableReason: 'Operator authorization is required.' };
    }
    if (authorization !== 'ready') {
        return { unavailableReason: 'Control authorization is not ready.' };
    }
    return capability
        ? { capability }
        : { unavailableReason: 'Retention cleanup is unavailable.' };
}
