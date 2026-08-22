import type { ReactNode } from 'react';
import { StatePanel, type StatePanelKind } from '../ui/StatePanel.tsx';
import type { FleetWorkspaceStatus } from './fleet-workspace-model.ts';
import styles from './FleetOperationalState.module.css';

const PRESENTATION: Readonly<
    Record<FleetWorkspaceStatus, Readonly<{ kind: StatePanelKind; title: string; message: string; }>>
> = {
    connecting: {
        kind: 'empty',
        title: 'Connecting to Fleet evidence',
        message: 'The root control snapshot has not arrived yet.'
    },
    live: {
        kind: 'empty',
        title: 'Fleet evidence is current',
        message: 'Live and accepted historical evidence use the current root snapshot.'
    },
    partial: {
        kind: 'stale',
        title: 'Fleet evidence is partial',
        message: 'Some root control collections are unavailable; supported evidence remains visible.'
    },
    stale: {
        kind: 'stale',
        title: 'Showing last-known Fleet evidence',
        message: 'Refresh failed or the snapshot aged out; timestamps and retained evidence remain authoritative.'
    },
    offline: {
        kind: 'error',
        title: 'Fleet control is offline',
        message: 'No current snapshot is available. Reconnect or use the operational legacy fallback.'
    },
    empty: {
        kind: 'empty',
        title: 'No Fleet reports yet',
        message: 'The optional report collection is present but contains no reports.'
    },
    'schema-error': {
        kind: 'error',
        title: 'Some Fleet reports were quarantined',
        message: 'Malformed or unsupported reports are excluded; accepted evidence remains visible below.'
    }
};

export function FleetOperationalState({
    acceptedCount,
    children,
    collection = 'present',
    isRefreshing,
    legacyHref,
    onRefresh,
    sourceCount,
    status
}: Readonly<{
    acceptedCount: number;
    children: ReactNode;
    collection?: 'absent' | 'present';
    isRefreshing: boolean;
    legacyHref: string;
    onRefresh(): void;
    sourceCount: number;
    status: FleetWorkspaceStatus;
}>) {
    const presentation = PRESENTATION[status];
    return (
        <div className={styles.root} data-fleet-operational-state={status}>
            {status === 'live' ? null : (
                <StatePanel kind={presentation.kind} title={presentation.title}>
                    <p>{presentation.message}</p>
                    <p className={styles.acceptance}>
                        {collection === 'absent'
                            ? 'Fleet report collection unavailable.'
                            : (
                                <>
                                    {acceptedCount.toLocaleString('en-US')} of {sourceCount.toLocaleString('en-US')}
                                    {' '}
                                    reports accepted.
                                </>
                            )}
                    </p>
                </StatePanel>
            )}
            <div aria-label="Fleet recovery actions" className={styles.actions}>
                <button
                    aria-busy={isRefreshing}
                    disabled={isRefreshing}
                    onClick={onRefresh}
                    type="button"
                >
                    {isRefreshing ? 'Refreshing…' : 'Refresh'}
                </button>
                <a href={legacyHref}>Open Legacy Fleet</a>
            </div>
            <div className={styles.evidence} data-fleet-retained-evidence>
                {children}
            </div>
        </div>
    );
}
