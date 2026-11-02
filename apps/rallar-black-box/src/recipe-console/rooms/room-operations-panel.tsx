import { AdminRoomInspection } from '@shared-web/browser/admin-rooms/admin-room-inspection.ts';
import { BrowserActivity } from '@shared-web/browser/browser-activity.ts';
import type {
    AdminRoomDirectoryEntry,
    AdminRoomDirectoryResponse
} from '@shared/api/admin-rooms/admin-room-directory.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { RoomExplanation } from './room-explanation.tsx';
import { RoomOperatorContext } from './room-operations-provider.tsx';
import styles from './room-operations.module.css';

interface RoomSelection {
    readonly scope: StateScope;
    readonly afterGroupId: string | null;
    readonly selectedGroupId: string | null;
}

export function RoomOperationsPanel() {
    const context = useContext(RoomOperatorContext);
    const [open, setOpen] = useState(false);
    return (
        <details className={styles.panel} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
            <summary>Room operations and recovery</summary>
            {open && (context !== null && context.issue === null
                ? <RoomSearch key={JSON.stringify([context.apiBaseUrl, context.sessionKey])} context={context} />
                : <p>{context?.issue ?? 'Sign in with an API administrator account to inspect rooms.'}</p>)}
        </details>
    );
}

function RoomSearch({ context }: { readonly context: RoomOperatorContext; }) {
    const [applicationId, setApplicationId] = useState('ar-eye-hunter');
    const [workspaceId, setWorkspaceId] = useState('default');
    const [selection, setSelection] = useState<RoomSelection | null>(null);
    return (
        <div className={styles.stack}>
            <p>
                Inspect rooms in one application and workspace, including private and archived rooms. API administrator
                access is checked on every request.
            </p>
            <form
                className={styles.search}
                onSubmit={(event) => {
                    event.preventDefault();
                    setSelection({
                        scope: { applicationId: applicationId.trim(), workspaceId: workspaceId.trim() },
                        afterGroupId: null,
                        selectedGroupId: null
                    });
                }}
            >
                <label>
                    Room application<input
                        value={applicationId}
                        required
                        onChange={(event) => {
                            setApplicationId(event.target.value);
                            setSelection(null);
                        }}
                    />
                </label>
                <label>
                    Room workspace<input
                        value={workspaceId}
                        required
                        onChange={(event) => {
                            setWorkspaceId(event.target.value);
                            setSelection(null);
                        }}
                    />
                </label>
                <button type="submit" disabled={!applicationId.trim() || !workspaceId.trim()}>Find rooms</button>
            </form>
            {selection !== null && <RoomInspection context={context} selection={selection} onSelect={setSelection} />}
        </div>
    );
}

interface RoomInspectionProps {
    readonly context: RoomOperatorContext;
    readonly selection: RoomSelection;
    readonly onSelect: (selection: RoomSelection) => void;
}

function RoomInspection({ context, selection, onSelect }: RoomInspectionProps) {
    const owner = useMemo(() =>
        new AdminRoomInspection({
            auth: context.auth,
            activity: new BrowserActivity(),
            timers: createDefaultTimers(),
            createId: () => crypto.randomUUID()
        }, { ...selection, apiBaseUrl: context.apiBaseUrl, refreshIntervalMs: 15_000 }), [
        context.auth,
        context.apiBaseUrl,
        selection
    ]);
    const subscribe = useCallback((notify: () => void) => owner.onChange(notify), [owner]);
    const getSnapshot = useCallback(() => owner.getState(), [owner]);
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    useEffect(() => {
        void owner.start();
        return () => owner.stop();
    }, [owner]);
    return (
        <div className={styles.stack}>
            <button type="button" onClick={() => void owner.refresh()}>Refresh room evidence</button>
            {state.error !== null && <p role="alert">Room inspection failed: {state.error}</p>}
            {state.view === null && state.error === null && <p role="status">Reading room evidence…</p>}
            {state.view !== null && (
                <>
                    <RoomDirectory directory={state.view.directory} selection={selection} onSelect={onSelect} />
                    {state.view.explanation !== null && <RoomExplanation narrative={state.view.explanation} />}
                </>
            )}
        </div>
    );
}

interface RoomDirectoryProps extends Pick<RoomInspectionProps, 'selection' | 'onSelect'> {
    readonly directory: AdminRoomDirectoryResponse;
}

function RoomDirectory({ directory, selection, onSelect }: RoomDirectoryProps) {
    return (
        <section aria-label="Operator room directory" className={styles.stack}>
            <p>Observed {new Date(directory.observedAtEpochMs).toISOString()}. Each page is a separate observation.</p>
            {directory.completeness === 'partial' && (
                <p role="status">
                    Incomplete evidence: invalid records are listed below and cannot be selected or repaired here.
                </p>
            )}
            {directory.entries.length === 0 && <p>No rooms on this page.</p>}
            <ul className={styles.rooms}>
                {directory.entries.map((entry) => (
                    <RoomDirectoryEntry
                        key={entry.status === 'valid' ? entry.room.roomRef.groupId : entry.roomRef.groupId}
                        entry={entry}
                        selection={selection}
                        onSelect={onSelect}
                    />
                ))}
            </ul>
            <div className={styles.actions}>
                {selection.afterGroupId !== null && (
                    <button
                        type="button"
                        onClick={() => onSelect({ ...selection, afterGroupId: null, selectedGroupId: null })}
                    >
                        First room page
                    </button>
                )}
                {directory.nextAfterGroupId !== null && (
                    <button
                        type="button"
                        onClick={() =>
                            onSelect({ ...selection, afterGroupId: directory.nextAfterGroupId, selectedGroupId: null })}
                    >
                        Next room page
                    </button>
                )}
            </div>
        </section>
    );
}

interface RoomDirectoryEntryProps extends Pick<RoomInspectionProps, 'selection' | 'onSelect'> {
    readonly entry: AdminRoomDirectoryEntry;
}

function RoomDirectoryEntry({ entry, selection, onSelect }: RoomDirectoryEntryProps) {
    if (entry.status === 'invalid') {
        return (
            <li>
                <strong>{entry.roomRef.groupId}</strong> — invalid room record; details unavailable.
            </li>
        );
    }
    return (
        <li>
            <button
                type="button"
                aria-pressed={selection.selectedGroupId === entry.room.roomRef.groupId}
                onClick={() => onSelect({ ...selection, selectedGroupId: entry.room.roomRef.groupId })}
            >
                Inspect {entry.room.displayName}
            </button>
            <span>
                {entry.room.status} · {entry.room.directoryListing} · {entry.room.joinMode} ·{' '}
                {entry.room.activeMemberCount} members
            </span>
        </li>
    );
}
