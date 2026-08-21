import type { DistributedRecipeTargetRow } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import { useMemo, type KeyboardEvent } from 'react';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import { ExplicitWindowControls } from '../ui/ExplicitWindowControls.tsx';
import { StatusMark, type OperationalStatus } from '../ui/StatusMark.tsx';
import styles from './ExecuteTargets.module.css';
import { useExecuteWindow } from './use-execute-window.ts';

const CONTENT_ID = 'execute-target-window';

export function ExecuteTargetWindow({
    contextKey,
    current,
    disabled,
    onToggle,
    rows,
    selected,
    selectionLocked
}: Readonly<{
    contextKey: string;
    current: boolean;
    disabled: boolean;
    onToggle(agentId: string): void;
    rows: readonly DistributedRecipeTargetRow[];
    selected: ReadonlySet<string>;
    selectionLocked: boolean;
}>) {
    const rowKeys = useMemo(() => createExecuteTargetRowKeys(rows), [rows]);
    const revisionKey = JSON.stringify(['execute-target-window-v1', rowKeys]);
    const window = useExecuteWindow({
        contextKey,
        revisionKey,
        section: 'targets',
        total: rows.length
    });
    const visible = rows.slice(window.model.startIndex, window.model.endIndexExclusive);
    return (
        <>
            {window.model.total > window.model.windowSize
                ? (
                    <div className={styles.windowControls} {...window.controlsFocusProps}>
                        <ExplicitWindowControls
                            contentId={CONTENT_ID}
                            itemLabel="targets"
                            label="Targets"
                            model={window.model}
                            onNext={window.next}
                            onPrevious={window.previous}
                        />
                    </div>
                )
                : null}
            <span
                className={styles.windowFocusAnchor}
                data-execute-window-focus-anchor="targets"
                ref={window.focusFallbackRef}
                tabIndex={-1}
            >
                {window.model.total === 0
                    ? 'No targets.'
                    : `Showing ${window.model.displayStart.toLocaleString('en-US')}–${
                        window.model.displayEnd.toLocaleString('en-US')
                    } of ${window.model.total.toLocaleString('en-US')} targets.`}
            </span>
            {window.model.total > window.model.windowSize
                ? (
                    <p className={styles.windowTruth} data-execute-window-truth="targets">
                        {outsideCount(window.model)} targets outside this window and browseable.
                    </p>
                )
                : null}
            <div
                aria-label="Target evidence table"
                className={styles.tableWrap}
                data-execute-target-scroller
                id={CONTENT_ID}
                onKeyDown={scrollTargetEvidenceFromKeyboard}
                role="region"
                tabIndex={0}
                {...window.contentFocusProps}
            >
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th scope="col">Select</th>
                            <th scope="col">Agent</th>
                            <th scope="col">Identity</th>
                            <th scope="col">Group</th>
                            <th scope="col">Last evidence</th>
                            <th scope="col">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map((row, offset) => (
                            <TargetRow
                                current={current}
                                disabled={disabled}
                                key={rowKeys[window.model.startIndex + offset]}
                                onToggle={onToggle}
                                row={row}
                                selected={selected.has(row.agentId)}
                                selectionLocked={selectionLocked}
                            />
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}

function scrollTargetEvidenceFromKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (
        event.target !== event.currentTarget || direction === 0 || event.altKey || event.ctrlKey || event.metaKey ||
        event.shiftKey
    ) {
        return;
    }
    const maximum = Math.max(0, event.currentTarget.scrollWidth - event.currentTarget.clientWidth);
    if (direction > 0 ? event.currentTarget.scrollLeft >= maximum : event.currentTarget.scrollLeft <= 0) {
        return;
    }
    event.preventDefault();
    event.currentTarget.scrollLeft += direction * 40;
}
export function createExecuteTargetRowKeys(
    rows: readonly Pick<DistributedRecipeTargetRow, 'agentId'>[]
): readonly string[] {
    const occurrences = new Map<string, number>();
    return rows.map((row) => {
        const occurrence = occurrences.get(row.agentId) ?? 0;
        occurrences.set(row.agentId, occurrence + 1);
        return JSON.stringify(['execute-target-row-v1', row.agentId, occurrence]);
    });
}

function TargetRow({ current, disabled, onToggle, row, selected, selectionLocked }: Readonly<{
    current: boolean;
    disabled: boolean;
    onToggle(agentId: string): void;
    row: DistributedRecipeTargetRow;
    selected: boolean;
    selectionLocked: boolean;
}>) {
    const selectable = current && row.targetable;
    return (
        <tr data-execute-target data-target-status={row.status}>
            <td className={styles.selectCell}>
                {selectable
                    ? (
                        <input
                            aria-label={`Select ${row.agentId}`}
                            checked={selected}
                            disabled={disabled || selectionLocked}
                            onChange={() => onToggle(row.agentId)}
                            type="checkbox"
                        />
                    )
                    : <span aria-label="Not selectable" className={styles.notSelectable}>—</span>}
            </td>
            <th scope="row">
                <ExactIdentifier value={row.agentId} />
            </th>
            <td>
                <span className={styles.identity}>
                    <span>{row.principalId ?? 'Identity unavailable'}</span>
                    <small>{row.sessionId ?? 'No session'}</small>
                </span>
            </td>
            <td>
                <code>{groupLabel(row)}</code>
            </td>
            <td>{lastEvidence(row)}</td>
            <td>
                <div className={styles.state}>
                    <StatusMark label={statusLabel(row.status)} status={statusTone(row.status)} />
                    <span className={styles.reason}>{row.reason}</span>
                </div>
            </td>
        </tr>
    );
}

function statusTone(status: DistributedRecipeTargetRow['status']): OperationalStatus {
    if (status === 'matched') {
        return 'passed';
    }
    if (status === 'stale') {
        return 'stale';
    }
    if (status === 'offline') {
        return 'disabled';
    }
    return status === 'different-group' || status === 'missing-identity' ? 'partial' : 'warning';
}
function statusLabel(status: DistributedRecipeTargetRow['status']): string {
    return status.split('-').map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
}
function groupLabel(row: DistributedRecipeTargetRow): string {
    const group = [row.applicationId, row.workspaceId, row.groupId].filter((value): value is string => Boolean(value));
    return group.length > 0 ? group.join(' / ') : 'Unavailable';
}
function lastEvidence(row: DistributedRecipeTargetRow): string {
    const epochMs = row.lastHeartbeatAtEpochMs ?? row.lastSeenAtEpochMs;
    return epochMs === undefined ? 'Unavailable' : new Date(epochMs).toLocaleTimeString();
}
function outsideCount(model: Readonly<{ total: number; startIndex: number; endIndexExclusive: number; }>): number {
    return model.total - (model.endIndexExclusive - model.startIndex);
}
