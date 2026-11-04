import type { ArenaMatchState } from '@ar-eye-hunter/arena-contracts.ts';
import { useState } from 'react';
import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
import { ArenaRematchControls } from './arena-rematch-controls.tsx';

interface MatchWinnerOverlayProps {
    readonly match: ArenaMatchState;
    readonly arena: ArenaConnection;
    readonly onReturnToBracket: () => void;
}
interface ArenaMatchOutcomeProps extends Omit<MatchWinnerOverlayProps, 'match'> {
    readonly match: ArenaMatchState | undefined;
}

export function ArenaMatchOutcome({ match, arena, onReturnToBracket }: ArenaMatchOutcomeProps) {
    const [dismissed, setDismissed] = useState<string | null>(null);
    const native = arena.tournament.snapshot;
    const cancelled = native?.status === 'cancelled';
    const matchId = cancelled ? native.binding.gameId : match?.matchId;
    if (matchId === undefined || matchId === dismissed) {
        return null;
    }
    const returnToBracket = () => {
        setDismissed(matchId);
        onReturnToBracket();
    };
    if (cancelled) {
        return (
            <section className="match-winner" role="dialog" aria-modal="false" aria-label="Tournament match cancelled">
                <div className="match-winner__panel">
                    <h2>Tournament match cancelled</h2>
                    <p>This attempt has stopped. No further score or result will be accepted.</p>
                    <button type="button" onClick={returnToBracket}>Return to tournament bracket</button>
                </div>
            </section>
        );
    }
    return match ? <MatchWinnerOverlay match={match} arena={arena} onReturnToBracket={returnToBracket} /> : null;
}

export function MatchWinnerOverlay({
    match,
    arena,
    onReturnToBracket
}: MatchWinnerOverlayProps) {
    const winner = match.results?.[0];
    const tied = arena.tournament.mode === 'tournament' && winner !== undefined &&
        match.results?.[1]?.scoreDelta === winner.scoreDelta;
    return (
        <section className="match-winner" role="dialog" aria-modal="false" aria-label="Match results">
            <div className="match-winner__panel">
                <span className="match-winner__eyebrow">Arena Match Complete</span>
                <h2>
                    {tied
                        ? 'Tied score — replay required'
                        : winner
                        ? `${winner.username} survives the metrics`
                        : 'The metrics are inconclusive'}
                </h2>
                <p>
                    {tied
                        ? 'Equal native scores do not advance either player. Return to the bracket for a fresh match.'
                        : winner
                        ? `${winner.scoreDelta} score, ${winner.killsDelta} eliminations, ${winner.deathsDelta} deaths. HR calls this character building.`
                        : 'Nobody won, which is legally cheaper.'}
                </p>
                <div className="match-results">
                    {(match.results ?? []).slice(0, 5).map((standing) => (
                        <div className="match-result-row" key={standing.sessionId}>
                            <strong>#{standing.rank} {standing.username}</strong>
                            <span>{standing.scoreDelta} pts</span>
                            <span>{standing.killsDelta} K</span>
                            <span>{standing.deathsDelta} D</span>
                        </div>
                    ))}
                </div>
                <ArenaRematchControls
                    key={`${arena.session?.sessionId}:${match.matchId}`}
                    match={match}
                    arena={arena}
                />
                {arena.tournament.mode === 'tournament'
                    ? <button type="button" onClick={onReturnToBracket}>Return to tournament bracket</button>
                    : <CasualArenaActions arena={arena} />}
            </div>
        </section>
    );
}

function CasualArenaActions({ arena }: Pick<MatchWinnerOverlayProps, 'arena'>) {
    return (
        <div className="button-grid" aria-label="Arena actions">
            <button type="button" onClick={() => void arena.leaveRoom()}>Leave arena</button>
            {arena.spectating
                ? <button type="button" onClick={() => void arena.joinAsPlayer()}>Join as player</button>
                : (
                    <button type="button" onClick={() => arena.roomId && void arena.watchRoom(arena.roomId)}>
                        Watch next match
                    </button>
                )}
            {!arena.spectating && !arena.directorStatus.isDirector && (
                <button
                    type="button"
                    onClick={() => void arena.appointSelfAsDirector()}
                >
                    Appoint this SPA
                </button>
            )}
        </div>
    );
}
