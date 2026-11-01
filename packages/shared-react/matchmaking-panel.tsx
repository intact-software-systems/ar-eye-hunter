import type { RallarMatchmaking } from '@shared-web/browser/matchmaking/rallar-matchmaking.ts';
import type { MatchmakingEndedReason, MatchmakingSnapshot } from '@shared/api/matchmaking/matchmaking-snapshot.ts';
import { useEffect, useState } from 'react';

export interface MatchmakingPanelProps {
    readonly owner: RallarMatchmaking;
    readonly findLabel: string;
}

const ENDED_MESSAGES: Readonly<Record<MatchmakingEndedReason, string>> = {
    'search-timeout': 'No group was found before the search ended.',
    'confirmation-timeout': 'Confirmation timed out. All reservations were released.',
    cancelled: 'Search cancelled.',
    declined: 'A player declined. All reservations were released.',
    'admission-denied': 'The group could not enter a room. All reservations were released.'
};

export function MatchmakingPanel({ owner, findLabel }: MatchmakingPanelProps) {
    const [state, setState] = useState(owner.getState());
    useEffect(() => owner.onChange(setState), [owner]);
    useEffect(() => {
        void owner.start();
        return () => owner.stop();
    }, [owner]);
    const disabled = state.busy || state.retryPending;
    return (
        <section className="panel stack" aria-label="Find players">
            <strong>Find players</strong>
            <p>Form a new group. Everyone confirms before a room is created.</p>
            {state.snapshot && (
                <MatchmakingProgress
                    owner={owner}
                    snapshot={state.snapshot}
                    disabled={disabled}
                    findLabel={findLabel}
                />
            )}
            {!state.snapshot && !state.error && <p role="status">Checking your search…</p>}
            {state.busy && <p role="status">Updating your search…</p>}
            {state.error && <p role="alert">{state.error}</p>}
            {state.retryPending && (
                <button type="button" disabled={state.busy} onClick={() => void owner.retry()}>
                    Retry matchmaking request
                </button>
            )}
            <button type="button" disabled={state.busy} onClick={() => void owner.refresh()}>Refresh search</button>
        </section>
    );
}

interface MatchmakingProgressProps extends MatchmakingPanelProps {
    readonly snapshot: MatchmakingSnapshot;
    readonly disabled: boolean;
}

function MatchmakingProgress({ owner, snapshot, disabled, findLabel }: MatchmakingProgressProps) {
    const { state } = snapshot;
    if (state.status === 'searching') {
        return (
            <>
                <p role="status">Searching for players · {remainingSeconds(snapshot)} seconds left</p>
                <button type="button" disabled={disabled} onClick={() => void owner.cancel()}>Cancel search</button>
            </>
        );
    }
    if (state.status === 'confirming') {
        return <MatchmakingConfirmation owner={owner} snapshot={snapshot} disabled={disabled} />;
    }
    if (state.status === 'matched') {
        return (
            <>
                <p role="status">Your group is ready. Enter the room, then the leader starts gameplay.</p>
                <button type="button" disabled={disabled} onClick={() => void owner.enter()}>Enter matched room</button>
                <button type="button" disabled={disabled} onClick={() => void owner.find()}>{findLabel}</button>
            </>
        );
    }
    return (
        <>
            {state.status === 'ended' && (
                <p role="status">{ENDED_MESSAGES[state.reason]} Start a new search when ready.</p>
            )}
            <button type="button" className="primary" disabled={disabled} onClick={() => void owner.find()}>
                {findLabel}
            </button>
        </>
    );
}

function MatchmakingConfirmation({ owner, snapshot, disabled }: Omit<MatchmakingProgressProps, 'findLabel'>) {
    const { state } = snapshot;
    if (state.status !== 'confirming') {
        return null;
    }
    const confirmed = state.players.find((player) => player.principalId === snapshot.principalId)?.confirmed === true;
    return (
        <>
            <p role="status">Players found · {remainingSeconds(snapshot)} seconds to confirm</p>
            <ul>
                {state.players.map((player) => (
                    <li key={player.principalId}>
                        {player.principalId === snapshot.principalId ? 'You' : player.principalId}:{' '}
                        {player.confirmed ? 'Confirmed' : 'Not confirmed'}
                    </li>
                ))}
            </ul>
            {confirmed
                ? <p>Waiting for the other players.</p>
                : (
                    <button type="button" className="primary" disabled={disabled} onClick={() => void owner.confirm()}>
                        Confirm match
                    </button>
                )}
            <button type="button" disabled={disabled} onClick={() => void owner.cancel()}>Decline match</button>
        </>
    );
}

function remainingSeconds(snapshot: MatchmakingSnapshot): number {
    const { state } = snapshot;
    return state.status === 'searching' || state.status === 'confirming'
        ? Math.max(0, Math.ceil((state.expiresAtEpochMs - snapshot.observedAtEpochMs) / 1000))
        : 0;
}
