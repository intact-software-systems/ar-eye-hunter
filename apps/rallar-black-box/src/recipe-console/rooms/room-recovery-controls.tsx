import type { AdminRoomOperations } from '@shared-web/browser/admin-rooms/admin-room-operations.ts';
import type { AuthenticatedResource } from '@shared-web/browser/api/authenticated-resource.ts';
import type { AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';
import { useState } from 'react';
import styles from './room-operations.module.css';

interface RoomRecoveryControlsProps {
    readonly owner: AdminRoomOperations;
    readonly state: AuthenticatedResource.State<AdminRoomOperations.View>;
    readonly selectedGroupId: string | null;
}

export function RoomRecoveryControls({ owner, state, selectedGroupId }: RoomRecoveryControlsProps) {
    const disabled = state.busy || state.retryPending || state.view === null;
    const selected = state.view?.directory.entries.find((entry) =>
        entry.status === 'valid' && entry.room.roomRef.groupId === selectedGroupId
    );
    const canRecompute = selected?.status === 'valid' && selected.room.status === 'active';
    return (
        <section aria-label="Recovery actions" className={styles.stack}>
            <h2>Recovery actions</h2>
            <p>
                Recompute uses current live presence to plan and publish this room’s topology. It does not add members,
                start a game or restore a deleted room.
            </p>
            <button
                type="button"
                disabled={disabled || !canRecompute || state.view?.topology?.work.status === 'pending'}
                onClick={() => void owner.act({ kind: 'recompute' })}
            >
                Recompute room topology
            </button>
            {selectedGroupId !== null && (
                <p>
                    Room scope: {state.view?.directory.scope.applicationId} / {state.view?.directory.scope.workspaceId}
                    {' '}
                    / {selectedGroupId}
                </p>
            )}
            {!canRecompute && <p>Select a valid active room to recompute its topology.</p>}
            {state.view?.topology && <TopologyOutcome outcome={state.view.topology} />}
            <GlobalMaintenance owner={owner} disabled={disabled} outcome={state.view?.maintenance ?? null} />
        </section>
    );
}

function TopologyOutcome({ outcome }: { readonly outcome: AdminRoomOperations.TopologyOutcome; }) {
    const messages = {
        pending: 'Accepted; topology work is pending. A queued receipt does not prove completion.',
        completed:
            'Work completed. Room evidence was reread after completion. Connectivity and gameplay recovery are not confirmed; check the remaining evidence and restrictions below.',
        failed: 'Topology work failed. Room evidence was reread; the room is not confirmed recovered.',
        unknown:
            'Outcome unknown: the exact work record is absent or expired. Refreshed room evidence cannot prove this command completed.'
    };
    return (
        <section aria-label="Room recovery outcome" role="region" aria-live="polite">
            <p>{messages[outcome.work.status]}</p>
            <p>Request: {outcome.receipt.requestId}</p>
            <p>
                Observed {new Date(outcome.work.observedAtEpochMs).toISOString()}. Attempts:{' '}
                {outcome.work.attempts ?? 'unknown'}.
            </p>
        </section>
    );
}

interface GlobalMaintenanceProps {
    readonly owner: AdminRoomOperations;
    readonly disabled: boolean;
    readonly outcome: AdminRoomOperations.MaintenanceOutcome | null;
}

const GLOBAL_CATEGORIES = ['runtime-state', 'resource-inbox', 'resource-inbox-results'] as const;

function GlobalMaintenance({ owner, disabled, outcome }: GlobalMaintenanceProps) {
    const [categories, setCategories] = useState<readonly Exclude<AdminPruneExpiredCategory, 'app-data'>[]>(
        GLOBAL_CATEGORIES
    );
    const matchesPreview = outcome?.result.status === 'dry-run' &&
        outcome.result.results.length === categories.length &&
        outcome.result.results.every((entry, index) => entry.category === categories[index]);
    return (
        <details className={styles.stack}>
            <summary>Global expired-record maintenance</summary>
            <p>
                This affects all applications and workspaces, regardless of the selected room. It deletes expired
                records in the selected stores, including expired recovery evidence. It does not repair corrupt records
                or erase unexpired game saves.
            </p>
            <fieldset disabled={disabled}>
                <legend>Global stores to clean</legend>
                {GLOBAL_CATEGORIES.map((category) => (
                    <label key={category} className={styles.check}>
                        <input
                            type="checkbox"
                            checked={categories.includes(category)}
                            onChange={(event) =>
                                setCategories(
                                    GLOBAL_CATEGORIES.filter((entry) =>
                                        entry === category ? event.target.checked : categories.includes(entry)
                                    )
                                )}
                        />
                        {category}
                    </label>
                ))}
            </fieldset>
            <button
                type="button"
                disabled={disabled || categories.length === 0}
                onClick={() => void owner.act({ kind: 'preview-maintenance', categories })}
            >
                Preview global cleanup
            </button>
            {outcome !== null && <MaintenanceOutcome outcome={outcome} />}
            {outcome !== null && matchesPreview && (
                <ExecuteMaintenance
                    key={outcome.requestId}
                    owner={owner}
                    disabled={disabled}
                    previewRequestId={outcome.requestId}
                />
            )}
        </details>
    );
}

function MaintenanceOutcome({ outcome }: { readonly outcome: AdminRoomOperations.MaintenanceOutcome; }) {
    return (
        <section aria-label="Global maintenance result" role="region" aria-live="polite">
            <p>
                {outcome.result.status === 'dry-run'
                    ? 'Preview complete. No records were deleted.'
                    : 'Cleanup completed. Room evidence was reread; cleanup does not prove gameplay recovery.'}
            </p>
            <p>Request: {outcome.requestId}. Job: {outcome.result.jobId}.</p>
            <ul>
                {outcome.result.results.map((entry) => (
                    <li key={entry.category}>
                        {entry.category}: {entry.expiredRows} expired, {entry.deletedRows} deleted.
                    </li>
                ))}
            </ul>
        </section>
    );
}

interface ExecuteMaintenanceProps extends Pick<GlobalMaintenanceProps, 'owner' | 'disabled'> {
    readonly previewRequestId: string;
}

function ExecuteMaintenance({ owner, disabled, previewRequestId }: ExecuteMaintenanceProps) {
    const [confirmed, setConfirmed] = useState(false);
    return (
        <div className={styles.stack}>
            <p>Execution uses a fresh server cutoff. Counts can differ from the preview.</p>
            <label className={styles.check}>
                <input
                    type="checkbox"
                    disabled={disabled}
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                />I understand cleanup affects all applications and workspaces.
            </label>
            <button
                type="button"
                disabled={disabled || !confirmed}
                onClick={() => void owner.act({ kind: 'execute-maintenance', previewRequestId })}
            >
                Execute global cleanup
            </button>
        </div>
    );
}
