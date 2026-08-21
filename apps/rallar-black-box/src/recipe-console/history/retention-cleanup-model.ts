import type { ControlRetentionConfirmation, ControlRetentionPreview } from '../control/control-retention-validation.ts';
import { projectHistoryRetentionCandidateRows, type HistoryRetentionCandidateRow } from './history-model.ts';

export type RetentionCleanupStatus =
    | 'idle'
    | 'previewing'
    | 'preview-ready'
    | 'confirming'
    | 'succeeded'
    | 'drift'
    | 'error'
    | 'unavailable';

export type RetentionCleanupPreview = Readonly<{
    current: boolean;
    retainedRuns: number;
    maxRuns: number;
    projectedRetainedRuns: number;
    candidates: readonly HistoryRetentionCandidateRow[];
    wouldDeleteRunIds: readonly string[];
    wouldDeleteDistributedRunIds: readonly string[];
    wouldDeleteFleetReportIds: readonly string[];
    preserves: Readonly<{
        connectedAgentSockets: true;
        storedArtifactFiles: true;
    }>;
}>;

export type RetentionCleanupState = Readonly<{
    status: RetentionCleanupStatus;
    preview?: RetentionCleanupPreview;
    message?: string;
    confirmation?: ControlRetentionConfirmation;
}>;

export type RetentionCleanupController = Readonly<{
    state: RetentionCleanupState;
    canPreview: boolean;
    canConfirm: boolean;
    busy: boolean;
    preview(): Promise<void>;
    confirm(
        afterConfirmed?: (
            confirmation: ControlRetentionConfirmation,
            preview: RetentionCleanupPreview,
            signal: AbortSignal
        ) => void | Promise<void>
    ): Promise<void>;
}>;

export function sanitizeRetentionCleanupPreview(
    raw: ControlRetentionPreview
): RetentionCleanupPreview {
    const candidates = projectHistoryRetentionCandidateRows(raw.wouldDeleteRuns)
        .map((candidate) =>
            Object.freeze({
                ...candidate,
                distributedRuns: Object.freeze(candidate.distributedRuns.map((run) => Object.freeze({ ...run }))),
                fleetReportIds: Object.freeze([...candidate.fleetReportIds])
            })
        );
    return Object.freeze({
        current: true,
        retainedRuns: raw.retainedRuns,
        maxRuns: raw.maxRuns,
        projectedRetainedRuns: raw.projectedRetainedRuns,
        candidates: Object.freeze(candidates),
        wouldDeleteRunIds: Object.freeze([...raw.wouldDeleteRunIds]),
        wouldDeleteDistributedRunIds: Object.freeze([
            ...raw.wouldDeleteDistributedRunIds
        ]),
        wouldDeleteFleetReportIds: Object.freeze([
            ...raw.wouldDeleteFleetReportIds
        ]),
        preserves: Object.freeze({ ...raw.preserves })
    });
}

export function staleRetentionCleanupPreview(
    value: RetentionCleanupPreview
): RetentionCleanupPreview {
    return value.current ? Object.freeze({ ...value, current: false }) : value;
}

export function invalidatedRetentionCleanupState(
    previous: RetentionCleanupState,
    reason?: string
): RetentionCleanupState {
    return freezeRetentionCleanupState({
        status: 'unavailable',
        message: reason ?? 'The control connection changed. Preview cleanup again.',
        ...(previous.preview
            ? { preview: staleRetentionCleanupPreview(previous.preview) }
            : {})
    });
}

export function unavailableRetentionCleanupState(
    reason?: string
): RetentionCleanupState {
    return freezeRetentionCleanupState({
        status: 'unavailable',
        message: reason ?? 'Retention cleanup is unavailable.'
    });
}

export function freezeRetentionCleanupState(
    value: RetentionCleanupState
): RetentionCleanupState {
    return Object.freeze(value);
}

export function freezeRetentionConfirmation(
    value: ControlRetentionConfirmation
): ControlRetentionConfirmation {
    return Object.freeze({
        ...value,
        deletedRunIds: Object.freeze([...value.deletedRunIds])
    });
}

export function isRetentionAbortError(error: unknown): boolean {
    return Boolean(
        error && typeof error === 'object' &&
            (error as { name?: unknown; }).name === 'AbortError'
    );
}

export function isRetentionConflict(error: unknown): boolean {
    return Boolean(
        error && typeof error === 'object' &&
            (error as { status?: unknown; }).status === 409
    );
}

export function retentionErrorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim()
        ? error.message
        : 'Retention cleanup failed.';
}
